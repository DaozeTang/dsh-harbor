/**
 * Remote editor saves.
 *
 * SFTP has no atomic compare-and-swap, so a save is bracketed by two reads:
 * the first proves the file still matches what the editor opened, the second
 * proves it did not change while we were checking. A mismatch aborts before
 * the remote file is replaced. No backup copy is written — version history is
 * the operator's own concern (Git, snapshots, etc.), and an editor save must
 * not leave hidden files in the remote directory.
 */

const LIMIT = 10 * 1024 * 1024;

async function readBounded(sftp, path) {
  const stream = sftp.createReadStream(path);
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > LIMIT) { stream.destroy(); throw new Error("Remote file exceeds the editor size limit"); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function write(sftp, path, bytes) {
  await new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(path);
    stream.once("error", reject);
    stream.once("close", resolve);
    stream.end(bytes);
  });
}

/**
 * Save one editor buffer over its remote file.
 * @param {object} sftp - opened sftp2 session.
 * @param {string} path - remote path being saved.
 * @param {Buffer} expected - bytes the editor opened.
 * @param {Buffer} replacement - bytes to write.
 * @returns {Promise<{bytes: number}>} written byte count.
 */
export async function saveEditorFile(sftp, path, expected, replacement) {
  if (expected.length > LIMIT || replacement.length > LIMIT) throw new Error("File exceeds the editor size limit");
  const current = await readBounded(sftp, path);
  if (!current.equals(expected)) throw new Error("Remote file changed since it was opened; reload before saving");
  const again = await readBounded(sftp, path);
  if (!again.equals(current)) throw new Error("Remote file changed during save; reload before saving");
  await write(sftp, path, replacement);
  return { bytes: replacement.length };
}
