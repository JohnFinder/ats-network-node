import { createHash, randomUUID } from 'node:crypto';

// One gateway credential protects this in-memory cache. A multi-tenant service
// must create a separate instance per authenticated principal.
export class ReferenceCache {
  #entries = new Map();
  #bytes = 0;
  #limit = 32 * 1024 * 1024;
  #lifetime = 30 * 60 * 1000;
  #remove(id) {
    const entry = this.#entries.get(id);
    if (entry) { this.#bytes -= entry.bytes; this.#entries.delete(id); }
  }
  #purge() {
    const before = Date.now() - this.#lifetime;
    for (const [id, entry] of this.#entries) if (entry.accessed < before) this.#remove(id);
  }
  register(audio) {
    this.#purge();
    const digest = createHash('sha256').update(audio).digest('hex');
    for (const [id, entry] of this.#entries) {
      if (entry.digest === digest) { entry.accessed = Date.now(); return id; }
    }
    const bytes = Buffer.byteLength(audio);
    if (bytes > this.#limit) throw new Error('reference_too_large');
    while (this.#entries.size >= 64 || this.#bytes + bytes > this.#limit) {
      let oldest;
      for (const pair of this.#entries) if (!oldest || pair[1].accessed < oldest[1].accessed) oldest = pair;
      if (!oldest) break;
      this.#remove(oldest[0]);
    }
    const id = randomUUID();
    this.#entries.set(id, { audio, digest, bytes, accessed: Date.now() });
    this.#bytes += bytes;
    return id;
  }
  get(id) {
    this.#purge();
    const entry = this.#entries.get(id);
    if (!entry) return undefined;
    entry.accessed = Date.now();
    return entry.audio;
  }
}
