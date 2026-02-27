import path from "path";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { access } from "fs/promises";
import { constants as fsConstants } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

type TYtDlpResult = { url: string; title: string };
type TYtDlpPlaylistEntry = { sourceUrl: string; title: string };

type TYtDlpOptions = {
  log: (...messages: unknown[]) => void;
  debug: (...messages: unknown[]) => void;
  error: (...messages: unknown[]) => void;
};

type TYtDlpPlaylistOptions = TYtDlpOptions & {
  start?: number;
  end?: number;
};

const getYtDlpPath = (): string => {
  const binaryName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  return path.join(__dirname, "bin", binaryName);
};

const getCookiesPath = (): string => path.join(__dirname, "bin", "cookies.txt");

const isYouTubeUrl = (url: string): boolean =>
  url.includes("youtube.com") ||
  url.includes("youtu.be") ||
  url.startsWith("ytsearch:");

const isYouTubePlaylistUrl = (url: string): boolean =>
  isYouTubeUrl(url) && /[?&]list=/.test(url);

const fileExists = async (p: string) => {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const runYtDlp = async (
  cmd: string[],
  options: TYtDlpOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const proc = Bun.spawn({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (stderr.trim()) options.error("[yt-dlp]", stderr.trim());

  return { stdout, stderr, exitCode };
};

const getBaseCommand = async () => {
  const ytDlpPath = getYtDlpPath();
  const cookiesPath = getCookiesPath();

  const base = [ytDlpPath, "--js-runtimes", "bun"];
  const cookiesArgs = (await fileExists(cookiesPath))
    ? ["--cookies", cookiesPath]
    : [];

  return { ytDlpPath, base, cookiesArgs };
};

const fetchYouTubeAudio = async (
  sourceUrl: string,
  options: TYtDlpOptions,
): Promise<TYtDlpResult> => {
  const { ytDlpPath, base, cookiesArgs } = await getBaseCommand();

  options.log("Using yt-dlp binary at:", ytDlpPath);
  options.log("Fetching audio URL from YouTube:", sourceUrl);

  const urlCmd = [...base, ...cookiesArgs, "-f", "bestaudio", "-g", sourceUrl];

  options.log("Running command:", urlCmd.join(" "));

  const urlRes = await runYtDlp(urlCmd, options);

  if (urlRes.exitCode !== 0) {
    throw new Error(`yt-dlp failed (exit ${urlRes.exitCode})`);
  }

  const url = urlRes.stdout.trim().split(/\r?\n/).filter(Boolean)[0];

  if (!url) throw new Error("yt-dlp returned empty URL");

  const titleCmd = [...base, ...cookiesArgs, "--get-title", sourceUrl];

  options.log("Running command:", titleCmd.join(" "));

  const titleRes = await runYtDlp(titleCmd, options);

  if (titleRes.exitCode !== 0) {
    throw new Error(`yt-dlp title fetch failed (exit ${titleRes.exitCode})`);
  }

  const title =
    titleRes.stdout.trim().split(/\r?\n/).filter(Boolean)[0] ?? sourceUrl;

  options.log("Audio URL fetched:", url);
  options.log("Title fetched:", title);

  return { url, title };
};

const fetchYouTubePlaylistEntries = async (
  playlistUrl: string,
  options: TYtDlpPlaylistOptions,
): Promise<TYtDlpPlaylistEntry[]> => {
  const { ytDlpPath, base, cookiesArgs } = await getBaseCommand();

  options.log("Using yt-dlp binary at:", ytDlpPath);
  options.log("Fetching playlist entries from:", playlistUrl);

  const rangeArgs: string[] = [];

  if (options.start && options.end) {
    rangeArgs.push("--playlist-items", `${options.start}:${options.end}`);
  } else if (options.start) {
    rangeArgs.push("--playlist-start", String(options.start));
  } else if (options.end) {
    rangeArgs.push("--playlist-end", String(options.end));
  }

  const cmd = [
    ...base,
    ...cookiesArgs,
    "--flat-playlist",
    "--print",
    "%(url)s\t%(title)s",
    ...rangeArgs,
    playlistUrl,
  ];

  options.debug("Running playlist command:", cmd.join(" "));

  const response = await runYtDlp(cmd, options);

  if (response.exitCode !== 0) {
    throw new Error(`yt-dlp playlist fetch failed (exit ${response.exitCode})`);
  }

  const entries = response.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [videoId, ...titleParts] = line.split("\t");

      if (!videoId) return null;

      const title = titleParts.join("\t").trim() || videoId;
      const url = videoId.startsWith("http")
        ? videoId
        : `https://www.youtube.com/watch?v=${videoId}`;

      return { sourceUrl: url, title };
    })
    .filter((entry): entry is TYtDlpPlaylistEntry => entry !== null);

  return entries;
};

export {
  fetchYouTubeAudio,
  fetchYouTubePlaylistEntries,
  isYouTubeUrl,
  isYouTubePlaylistUrl,
};
export type { TYtDlpResult, TYtDlpOptions, TYtDlpPlaylistEntry };
