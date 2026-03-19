import { open } from 'node:fs/promises';

const BOX_HEADER_SIZE = 8;
const EXTENDED_SIZE_BYTES = 8;

/**
 * Walks the top-level MP4 box structure to determine if the moov atom
 * appears before the mdat atom (i.e. the file is "faststart" optimized).
 *
 * If moov comes before mdat, HTTP 206 range requests can locate metadata
 * without downloading the entire file, enabling instant seek in players.
 *
 * @returns true if the file is already faststart-optimized, false otherwise.
 */
export async function isFaststartOptimized(filePath: string): Promise<boolean> {
  const handle = await open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const fileSize = stat.size;
    let offset = 0;
    let hasMoov = false;

    while (offset + BOX_HEADER_SIZE <= fileSize) {
      // Read the 8-byte box header: 4 bytes size (uint32 BE) + 4 bytes type (ASCII)
      const headerBuf = Buffer.alloc(BOX_HEADER_SIZE);
      const { bytesRead } = await handle.read(headerBuf, 0, BOX_HEADER_SIZE, offset);
      if (bytesRead < BOX_HEADER_SIZE) {
        break;
      }

      let boxSize = headerBuf.readUInt32BE(0);
      const boxType = headerBuf.toString('ascii', 4, 8);

      // Handle 64-bit extended box size (size field == 1)
      if (boxSize === 1) {
        if (offset + BOX_HEADER_SIZE + EXTENDED_SIZE_BYTES > fileSize) {
          break;
        }
        const extBuf = Buffer.alloc(EXTENDED_SIZE_BYTES);
        const { bytesRead: extRead } = await handle.read(extBuf, 0, EXTENDED_SIZE_BYTES, offset + BOX_HEADER_SIZE);
        if (extRead < EXTENDED_SIZE_BYTES) {
          break;
        }
        boxSize = Number(extBuf.readBigUInt64BE(0));
      }

      // A size of 0 means the box extends to the end of the file
      if (boxSize === 0) {
        boxSize = fileSize - offset;
      }

      // Guard against malformed files: box size must cover at least the header
      if (boxSize < BOX_HEADER_SIZE) {
        break;
      }

      if (boxType === 'moov') {
        hasMoov = true;
        offset += boxSize;
        continue;
      }
      if (boxType === 'moof') {
        return false;
      }
      if (boxType === 'mdat') {
        return hasMoov;
      }

      offset += boxSize;
    }

    // If we never found moov or mdat, treat as not optimized
    return false;
  } finally {
    await handle.close();
  }
}
