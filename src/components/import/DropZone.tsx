import { FileUploadArea } from './FileUploadArea'

/** Kompakte Upload-Zone im Workspace (z. B. ohne aktive Datei). */
export function DropZone() {
  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <FileUploadArea variant="compact" />
    </div>
  )
}
