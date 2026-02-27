import {
  type AppData,
  type PlainTransport,
  type PluginContext,
  type Producer,
} from "@sharkord/plugin-sdk";
import { spawnMusicStream, killMusicStream } from "./ffmpeg";
import { isYouTubeUrl, isYouTubePlaylistUrl, fetchYouTubePlaylistEntries } from "./yt-dlp";
import type { TMusicStreamResult } from "./ffmpeg";

let debug = false;

type QueueTrack = {
  sourceUrl: string;
  title: string;
};

type ChannelStreamState = {
  ffmpegProcess: TMusicStreamResult["process"] | null;
  audioProducer: Producer | null;
  audioTransport: PlainTransport<AppData> | null;
  router: any;
  routerCloseHandler: ((...args: unknown[]) => void) | null;
  producerCloseHandler: ((...args: unknown[]) => void) | null;
  currentSong: string | null;
  streamActive: boolean;
  streamStarting: boolean;
  volume: number;
  queue: QueueTrack[];
  playlistLoading: boolean;
  playbackNonce: number;
};

const channelStreams = new Map<number, ChannelStreamState>();

const getState = (channelId: number): ChannelStreamState => {
  let state = channelStreams.get(channelId);

  if (!state) {
    state = {
      ffmpegProcess: null,
      audioProducer: null,
      audioTransport: null,
      router: null,
      routerCloseHandler: null,
      producerCloseHandler: null,
      currentSong: null,
      streamActive: false,
      streamStarting: false,
      volume: 50,
      queue: [],
      playlistLoading: false,
      playbackNonce: 0,
    };

    channelStreams.set(channelId, state);
  }

  return state;
};

const cleanupStreamResources = (
  channelId: number,
  { invalidateCallbacks = false }: { invalidateCallbacks?: boolean } = {},
) => {
  const state = channelStreams.get(channelId);

  if (!state) return;

  if (invalidateCallbacks) {
    state.playbackNonce++;
  }

  killMusicStream(state.ffmpegProcess);

  state.ffmpegProcess = null;

  if (state.producerCloseHandler && state.audioProducer) {
    state.audioProducer.observer.off("close", state.producerCloseHandler);
  }

  if (state.routerCloseHandler) {
    state.router.off("@close", state.routerCloseHandler);
  }

  try {
    state.audioProducer?.close();
  } catch {}

  try {
    state.audioTransport?.close();
  } catch {}

  state.audioProducer = null;
  state.audioTransport = null;
  state.router = null;
  state.routerCloseHandler = null;
  state.producerCloseHandler = null;
  state.streamActive = false;
  state.currentSong = null;
  state.streamStarting = false;
};

const cleanupChannel = (channelId: number) => {
  const state = channelStreams.get(channelId);

  if (!state) return;

  cleanupStreamResources(channelId, { invalidateCallbacks: true });

  state.queue = [];
  state.playlistLoading = false;
};

const forceClean = () => {
  for (const channelId of channelStreams.keys()) {
    cleanupChannel(channelId);
  }

  try {
    Bun.spawnSync({ cmd: ["killall", "ffmpeg"] });
  } catch {}

  channelStreams.clear();
};

const startMusicStream = async (
  ctx: PluginContext,
  channelId: number,
  sourceUrl: string,
  bitrateSetting: string,
): Promise<string> => {
  const state = getState(channelId);

  if (state.streamActive) {
    throw new Error("Music is already playing in this channel.");
  }

  if (state.streamStarting) {
    throw new Error("Music is already starting. Please wait.");
  }

  state.streamStarting = true;
  const playbackNonce = ++state.playbackNonce;

  try {
    const router = ctx.actions.voice.getRouter(channelId);

    if (!router) throw new Error("Could not access voice channel");

    const { announcedAddress, ip } = await ctx.actions.voice.getListenInfo();

    state.router = router;

    state.routerCloseHandler = () => {
      ctx.log("Router closed, cleaning up channel", channelId);
      cleanupChannel(channelId);
    };

    state.router.on("@close", state.routerCloseHandler);

    const audioSsrc = Math.floor(Math.random() * 1e9);

    state.audioTransport = await router.createPlainTransport({
      listenIp: {
        ip,
        announcedIp: announcedAddress,
      },
      rtcpMux: true,
      comedia: true,
      enableSrtp: false,
    });

    state.audioProducer = await state.audioTransport.produce({
      kind: "audio",
      rtpParameters: {
        codecs: [
          {
            mimeType: "audio/opus",
            payloadType: 111,
            clockRate: 48000,
            channels: 2,
            parameters: {},
            rtcpFeedback: [],
          },
        ],
        encodings: [{ ssrc: audioSsrc }],
      },
    });

    ctx.log("Final source URL:", sourceUrl);

    const result = await spawnMusicStream({
      sourceUrl,
      audioPayloadType: 111,
      audioSsrc,
      rtpHost: ip,
      audioRtpPort: state.audioTransport.tuple.localPort,
      volume: state.volume,
      bitrate: bitrateSetting,
      error: (...m) => ctx.error(...m),
      log: (...m) => ctx.log(...m),
      debug: (...m) => {
        if (debug) {
          ctx.debug(...m);
        }
      },
      onEnd: () => {
        const currentState = channelStreams.get(channelId);

        if (!currentState) return;
        if (playbackNonce !== currentState.playbackNonce) return;
        if (!currentState.streamActive) return;

        ctx.log("Music ended in channel", channelId);
        cleanupStreamResources(channelId);
        void playNextInQueue(ctx, channelId, bitrateSetting);
      },
    });

    ctx.actions.voice.createStream({
      key: "music",
      channelId,
      title: result.title,
      avatarUrl: "https://i.imgur.com/uVBNUK9.png",
      producers: {
        audio: state.audioProducer,
      },
    });

    state.producerCloseHandler = () => {
      cleanupStreamResources(channelId);
      void playNextInQueue(ctx, channelId, bitrateSetting);
    };

    state.audioProducer.observer.on("close", state.producerCloseHandler);

    state.ffmpegProcess = result.process;
    state.currentSong = result.title;
    state.streamActive = true;

    return result.title;
  } catch (err) {
    cleanupStreamResources(channelId, { invalidateCallbacks: true });
    throw err;
  } finally {
    state.streamStarting = false;
  }
};

const playNextInQueue = async (
  ctx: PluginContext,
  channelId: number,
  bitrateSetting: string,
) => {
  const state = getState(channelId);

  if (state.streamActive || state.streamStarting) {
    return;
  }

  const nextTrack = state.queue.shift();

  if (!nextTrack) {
    return;
  }

  try {
    await startMusicStream(ctx, channelId, nextTrack.sourceUrl, bitrateSetting);
  } catch (err) {
    ctx.error("Failed to play queued track:", nextTrack.title, err);
    void playNextInQueue(ctx, channelId, bitrateSetting);
  }
};

const onLoad = async (ctx: PluginContext) => {
  const settings = await ctx.settings.register([
    {
      key: "bitrate",
      name: "Bitrate",
      description: "The bitrate for the music stream",
      type: "string",
      defaultValue: "128k",
    },
  ]);

  ctx.commands.register<{ query: string }>({
    name: "play",
    description: "Play music from YouTube or a direct URL",
    args: [
      {
        name: "query",
        description: "YouTube URL, search query, direct audio URL, or playlist URL",
        type: "string",
        required: true,
      },
    ],
    executes: async (invoker, input) => {
      const channelId = invoker.currentVoiceChannelId;

      if (!channelId) {
        throw new Error("You must be in a voice channel to play music.");
      }

      if (!input.query) {
        throw new Error("You must provide a search query or URL.");
      }

      const state = getState(channelId);
      const bitrate = await settings.get("bitrate");

      ctx.log(`Query: ${input.query} in channel ${channelId}`);

      if (isYouTubePlaylistUrl(input.query)) {
        if (state.playlistLoading) {
          throw new Error("A playlist is already being processed for this channel.");
        }

        state.playlistLoading = true;

        try {
          const [firstTrack] = await fetchYouTubePlaylistEntries(input.query, {
            start: 1,
            end: 1,
            log: (...m) => ctx.log(...m),
            error: (...m) => ctx.error(...m),
            debug: (...m) => {
              if (debug) {
                ctx.debug(...m);
              }
            },
          });

          if (!firstTrack) {
            throw new Error("No playable tracks found in playlist.");
          }

          state.queue.push({
            sourceUrl: firstTrack.sourceUrl,
            title: firstTrack.title,
          });
          void playNextInQueue(ctx, channelId, bitrate);

          void (async () => {
            try {
              const rest = await fetchYouTubePlaylistEntries(input.query, {
                start: 2,
                log: (...m) => ctx.log(...m),
                error: (...m) => ctx.error(...m),
                debug: (...m) => {
                  if (debug) {
                    ctx.debug(...m);
                  }
                },
              });

              if (!state.playlistLoading) {
                ctx.log("Playlist loading was cancelled; ignoring remaining tracks.");
                return;
              }

              state.queue.push(
                ...rest.map((track) => ({
                  sourceUrl: track.sourceUrl,
                  title: track.title,
                })),
              );
              ctx.log(`Loaded ${rest.length} additional playlist tracks for channel ${channelId}`);
            } catch (err) {
              ctx.error("Failed to finish playlist processing:", err);
            } finally {
              state.playlistLoading = false;
            }
          })();

          return `Queued playlist. Starting with: ${firstTrack.title}`;
        } catch (err) {
          state.playlistLoading = false;
          throw err;
        }
      }

      let sourceUrl = input.query;

      if (!/^https?:\/\//.test(sourceUrl)) {
        sourceUrl = `ytsearch:${sourceUrl}`;
      }

      const queueTrack: QueueTrack = {
        sourceUrl,
        title: input.query,
      };

      state.queue.push(queueTrack);
      const queuePosition = state.streamActive || state.streamStarting ? state.queue.length : 1;

      void playNextInQueue(ctx, channelId, bitrate);

      if (state.streamActive || state.streamStarting) {
        return `Queued at position ${queuePosition}: ${queueTrack.title}`;
      }

      return `Queued: ${queueTrack.title}`;
    },
  });

  ctx.commands.register<{ url: string }>({
    name: "play_direct",
    description: "Play music from a direct MP3 URL",
    args: [
      {
        name: "url",
        description: "Direct MP3 URL",
        type: "string",
        required: true,
      },
    ],
    executes: async (invoker, input) => {
      const channelId = invoker.currentVoiceChannelId;

      if (!channelId) {
        throw new Error("You must be in a voice channel to play music.");
      }

      if (!input.url) {
        throw new Error("You must provide a direct audio URL.");
      }

      if (!/^https?:\/\//.test(input.url)) {
        throw new Error("You must provide a direct http(s) URL.");
      }

      if (isYouTubeUrl(input.url)) {
        throw new Error("YouTube URLs are not supported by /play_direct.");
      }

      ctx.log(`Direct URL: ${input.url} in channel ${channelId}`);

      const state = getState(channelId);

      state.queue.push({ sourceUrl: input.url, title: input.url });
      const queuePosition = state.streamActive || state.streamStarting ? state.queue.length : 1;

      void playNextInQueue(ctx, channelId, await settings.get("bitrate"));

      if (state.streamActive || state.streamStarting) {
        return `Queued direct URL at position ${queuePosition}`;
      }

      return "Queued direct URL.";
    },
  });

  ctx.commands.register({
    name: "stop",
    description: "Stop music and clear the queue",
    executes: async (invoker) => {
      const channelId = invoker.currentVoiceChannelId;
      if (!channelId) return "You are not in a voice channel";

      const state = channelStreams.get(channelId);

      if (!state || (!state.streamActive && state.queue.length === 0 && !state.playlistLoading)) {
        return "Nothing is currently playing";
      }

      cleanupChannel(channelId);
      return "Stopped playback and cleared the queue.";
    },
  });

  ctx.commands.register({
    name: "skip",
    description: "Skip the current song",
    executes: async (invoker) => {
      const channelId = invoker.currentVoiceChannelId;
      if (!channelId) return "You are not in a voice channel";

      const state = channelStreams.get(channelId);
      if (!state || !state.streamActive) {
        return "Nothing is currently playing";
      }

      cleanupStreamResources(channelId, { invalidateCallbacks: true });
      void playNextInQueue(ctx, channelId, await settings.get("bitrate"));

      return "Skipped current song.";
    },
  });

  ctx.commands.register<{ index: number }>({
    name: "skipto",
    description: "Skip directly to a position in the queue (1 = current track)",
    args: [
      {
        name: "index",
        description: "Queue position to skip to",
        type: "number",
        required: true,
      },
    ],
    executes: async (invoker, input) => {
      const channelId = invoker.currentVoiceChannelId;
      if (!channelId) return "You are not in a voice channel";

      const state = channelStreams.get(channelId);
      if (!state || !state.streamActive) {
        return "Nothing is currently playing";
      }

      const wholeQueueLength = 1 + state.queue.length;

      if (!Number.isInteger(input.index)) {
        throw new Error("Index must be an integer.");
      }

      if (input.index < 1 || input.index > wholeQueueLength) {
        throw new Error(`Index must be between 1 and ${wholeQueueLength}.`);
      }

      if (input.index > 1) {
        const tracksToDrop = input.index - 2;
        if (tracksToDrop > 0) {
          state.queue.splice(0, tracksToDrop);
        }
      }

      cleanupStreamResources(channelId, { invalidateCallbacks: true });
      void playNextInQueue(ctx, channelId, await settings.get("bitrate"));

      return `Skipped to queue position ${input.index}.`;
    },
  });

  ctx.commands.register({
    name: "queue",
    description: "Show current queue",
    executes: async (invoker) => {
      const channelId = invoker.currentVoiceChannelId;
      if (!channelId) return "You are not in a voice channel";

      const state = channelStreams.get(channelId);
      if (!state || (!state.streamActive && state.queue.length === 0)) {
        return "Queue is empty.";
      }

      const rows: string[] = [];

      if (state.currentSong) {
        rows.push(`1. ▶ ${state.currentSong}`);
      }

      rows.push(...state.queue.slice(0, 20).map((track, index) => `${index + 2}. ${track.title}`));

      const hidden = state.queue.length > 20 ? `\n...and ${state.queue.length - 20} more tracks.` : "";
      const loading = state.playlistLoading ? "\n(playlist is still loading...)" : "";

      return `Queue:\n${rows.join("\n")}${hidden}${loading}`;
    },
  });

  ctx.commands.register({
    name: "clearqueue",
    description: "Clear upcoming tracks but keep current song playing",
    executes: async (invoker) => {
      const channelId = invoker.currentVoiceChannelId;
      if (!channelId) return "You are not in a voice channel";

      const state = channelStreams.get(channelId);
      if (!state || state.queue.length === 0) {
        return "Queue is already empty.";
      }

      state.queue = [];
      state.playlistLoading = false;

      return "Cleared queued tracks.";
    },
  });

  ctx.commands.register({
    name: "nowplaying",
    description: "Show what's currently playing",
    executes: async (invoker) => {
      const channelId = invoker.currentVoiceChannelId;
      if (!channelId) return "You are not in a voice channel";

      const state = channelStreams.get(channelId);
      if (!state || !state.streamActive || !state.currentSong) {
        return "Nothing is currently playing";
      }

      return `Now playing: ${state.currentSong}`;
    },
  });

  ctx.commands.register<{ level: number }>({
    name: "volume",
    description: "Set the volume level (0-100)",
    args: [
      {
        name: "level",
        description: "Volume level from 0 to 100",
        type: "number",
        required: true,
      },
    ],
    executes: async (invoker, input) => {
      const channelId = invoker.currentVoiceChannelId;
      if (!channelId) throw new Error("You are not in a voice channel");

      if (input.level < 0 || input.level > 100) {
        throw new Error("Volume must be between 0 and 100");
      }

      const state = getState(channelId);

      state.volume = input.level;

      return `Volume set to ${input.level}% (applies to next song)`;
    },
  });

  ctx.commands.register({
    name: "forceclean",
    description: "Cleanup all music streams (admin only)",
    executes: async () => {
      forceClean();
    },
  });

  ctx.commands.register({
    name: "musicbotdebug",
    description: "Toggle debug logging for Music Bot (admin only)",
    executes: async () => {
      debug = !debug;

      return `Music Bot debug logging is now ${debug ? "enabled" : "disabled"}`;
    },
  });

  ctx.events.on("voice:runtime_closed", ({ channelId }) => {
    cleanupChannel(channelId);
  });
};

const onUnload = (ctx: PluginContext) => {
  for (const channelId of channelStreams.keys()) {
    cleanupChannel(channelId);
  }

  channelStreams.clear();

  ctx.log("Music Bot Plugin unloaded");
};

export { onLoad, onUnload };
