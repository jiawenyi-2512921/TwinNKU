export type AudioOwner = "tour" | "assistant" | "video";
let sequence = 0;
let current: { owner: AudioOwner; lease: number; stop: () => void } | null =
  null;

/** One audible source across guide, questions and video, with stale-release protection. */
export function acquireAudio(owner: AudioOwner, stop: () => void): number {
  const previous = current;
  current = null;
  // The assistant's listen → think → speak loop reacquires its own lease.
  // Separate tour/video players must still stop their previous instance.
  if (!(owner === "assistant" && previous?.owner === owner)) previous?.stop();
  const lease = ++sequence;
  current = { owner, stop, lease };
  return lease;
}

export function releaseAudio(owner: AudioOwner, lease?: number): void {
  if (
    current?.owner === owner &&
    (lease === undefined || current.lease === lease)
  )
    current = null;
}

export function pauseTour(): void {
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event("twinnku:tour-pause"));
}
