/** A music file the user selected. Nothing has been read from it yet. */
export interface SourceFile {
  id: number;
  file: File;
  /** Location shown to the user, e.g. "My Music/Old Songs/track.mp3". */
  path: string;
  name: string;
  size: number;
  /** Lower-case extension without the dot, e.g. "mp3". */
  ext: string;
}

export interface SongMeta {
  title?: string;
  artist?: string;
  album?: string;
  /** Seconds. */
  duration?: number;
  /** Kilobits per second. */
  bitrate?: number;
  codec?: string;
  lossless?: boolean;
}

export interface ScannedFile extends SourceFile {
  meta: SongMeta;
  /** True when the song name came from the file name because the file has no title tag. */
  titleFromFileName: boolean;
  displayTitle: string;
  /** SHA-256 (hex). Only computed for files that share their exact size with another file. */
  hash?: string;
  /** A note about unreadable tags (the file itself was still readable). */
  metaWarning?: string;
}

export interface UnreadableFile {
  path: string;
  size: number;
  error: string;
}

export interface ExactGroup {
  id: string;
  hash: string;
  fileIds: number[];
  /** Suggested copy to keep. */
  defaultKeep: number;
}

/**
 * A "song" is either a single file or a set of byte-identical copies.
 * Key format: "f:<fileId>" for single files, "x:<exactGroupId>" for exact groups.
 */
export type SongKey = string;

export interface PotentialGroup {
  id: string;
  songKeys: SongKey[];
  reasons: string[];
  /** Suggested song to keep if the user confirms they are the same. */
  suggestedKeep: SongKey;
}

export interface ScanResult {
  sourceLabel: string;
  scannedAt: number;
  files: ScannedFile[];
  filesById: Map<number, ScannedFile>;
  exactGroups: ExactGroup[];
  potentialGroups: PotentialGroup[];
  /** File ids that have no detected duplicate of any kind. */
  uniqueIds: number[];
  unreadable: UnreadableFile[];
  hashedCount: number;
}

export type PotentialDecision =
  | { kind: 'later' }
  | { kind: 'different' }
  | { kind: 'same'; keep: SongKey };

export interface Decisions {
  /** exactGroupId -> fileId to keep */
  exactKeep: Record<string, number>;
  potential: Record<string, PotentialDecision>;
}

export const OUTPUT_ROOT = 'SongSort Output';
export const FOLDER_UNIQUE = 'Unique Songs';
export const FOLDER_DUPLICATES = 'Duplicates';
export const FOLDER_POTENTIAL = 'Potential Duplicates';
export type OutputFolder = typeof FOLDER_UNIQUE | typeof FOLDER_DUPLICATES | typeof FOLDER_POTENTIAL;
