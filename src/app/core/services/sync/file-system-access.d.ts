// File System Access API permission methods aren't yet in TS's DOM lib
// (lib.dom.d.ts as of 5.9 covers the handle types but not query/request
// permission). Minimal ambient augmentation; widen if more surfaces are
// needed later.

interface FileSystemHandlePermissionDescriptor {
    mode?: 'read' | 'readwrite';
}

type FileSystemPermissionState = 'granted' | 'denied' | 'prompt';

interface FileSystemHandle {
    queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<FileSystemPermissionState>;
    requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<FileSystemPermissionState>;
}

interface DirectoryPickerOptions {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos' | FileSystemHandle;
}

interface Window {
    showDirectoryPicker(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
}
