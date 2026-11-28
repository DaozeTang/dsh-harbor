/**
 * Minimal stand-in for one DSH storage-domain table.
 *
 * The service tests need get/put/delete/entries/size over an in-memory Map
 * and nothing else. Four copies of this used to live in the tests and had
 * already drifted (one lost `size`), which is the kind of difference that
 * makes a test pass for the wrong reason.
 */
export function fakeTable(entries = []) {
  const map = new Map(entries);
  return {
    get: (id) => map.get(id),
    put: (id, record) => { map.set(id, record); },
    delete: (id) => { map.delete(id); },
    entries: () => [...map.entries()],
    size: () => map.size
  };
}