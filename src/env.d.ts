/**
 * `showDirectoryPicker` is not in every TypeScript DOM lib yet, and Heartwood's
 * whole local path depends on it. Declared narrowly rather than pulling in a
 * dependency for four lines of types.
 */

interface DirectoryPickerOptions {
  id?: string;
  mode?: "read" | "readwrite";
  startIn?: FileSystemHandle | string;
}

interface Window {
  showDirectoryPicker?: (
    options?: DirectoryPickerOptions,
  ) => Promise<FileSystemDirectoryHandle>;
}
