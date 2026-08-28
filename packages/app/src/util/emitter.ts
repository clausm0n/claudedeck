type Handler<T> = (payload: T) => void

/** Tiny typed event emitter. */
export class Emitter<Events extends object> {
  private handlers = new Map<keyof Events, Set<Handler<never>>>()

  on<K extends keyof Events>(event: K, fn: Handler<Events[K]>): () => void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(fn as Handler<never>)
    return () => set!.delete(fn as Handler<never>)
  }

  protected emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.handlers.get(event)
    if (!set) return
    for (const fn of [...set]) {
      try {
        ;(fn as Handler<Events[K]>)(payload)
      } catch (err) {
        console.error(`handler for ${String(event)} threw`, err)
      }
    }
  }
}
