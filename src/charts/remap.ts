/**
 * Index-space remapping (10.3 follow-up).
 *
 * Drawings are anchored to a bar INDEX (the frozen anchor rule), and a resampling chart
 * type has its own index space: brick 400 is not minute 400. So switching between chart
 * types moves every annotation, which looks exactly like the drawings being lost.
 *
 * The fix keeps the contract and converts at the boundary. Time is the one coordinate
 * both spaces share, so an anchor is read as a timestamp in the OLD space and written
 * back as an index in the NEW one. Both directions interpolate, so a drawing between two
 * bars stays between the same two moments rather than snapping to a bar.
 *
 * Ascending times are required and are what both index spaces provide — the source series
 * is ascending by contract, and a derived bar's timestamp is the source bar it closed on.
 * Duplicates are allowed (several Renko bricks can complete inside one minute) and are
 * handled by taking the first matching index, which is the only stable choice.
 */

/** Timestamp at a possibly-fractional index, linearly interpolated. */
export function timeAtIndex(times: readonly number[], index: number): number {
  if (times.length === 0) return Number.NaN;
  if (times.length === 1) return times[0];

  if (index <= 0) {
    // Extrapolate backwards with the first step, so an anchor placed to the left of the
    // series keeps its distance instead of collapsing onto bar 0.
    const step = times[1] - times[0];
    return times[0] + index * step;
  }
  const last = times.length - 1;
  if (index >= last) {
    const step = times[last] - times[last - 1];
    return times[last] + (index - last) * step;
  }
  const lower = Math.floor(index);
  const fraction = index - lower;
  return times[lower] + (times[lower + 1] - times[lower]) * fraction;
}

/** Fractional index at a timestamp — the inverse of `timeAtIndex`. */
export function indexAtTime(times: readonly number[], t: number): number {
  if (times.length === 0) return Number.NaN;
  if (times.length === 1) return 0;
  const last = times.length - 1;

  if (t <= times[0]) {
    const step = times[1] - times[0];
    return step === 0 ? 0 : (t - times[0]) / step;
  }
  if (t >= times[last]) {
    const step = times[last] - times[last - 1];
    return step === 0 ? last : last + (t - times[last]) / step;
  }

  // Lower bound: the FIRST index whose time is >= t. Searching for the first rather than
  // the last is what makes duplicates stable — several Renko bricks can share a source
  // timestamp, and returning the last one would move an anchor every time the brick count
  // inside that minute changed.
  let low = 0;
  let high = last;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (times[mid] >= t) high = mid;
    else low = mid + 1;
  }
  if (times[low] === t) return low;

  // Otherwise t falls strictly between low - 1 and low.
  const previous = Math.max(0, low - 1);
  const span = times[low] - times[previous];
  return span === 0 ? previous : previous + (t - times[previous]) / span;
}

/**
 * An index in `from`'s space expressed in `to`'s space.
 *
 * Returns the index unchanged when either space is unusable, so a remap can never destroy
 * an anchor it cannot improve.
 */
export function remapIndex(
  from: readonly number[],
  to: readonly number[],
  index: number,
): number {
  if (from.length < 2 || to.length < 2 || !Number.isFinite(index)) return index;
  const t = timeAtIndex(from, index);
  if (!Number.isFinite(t)) return index;
  const mapped = indexAtTime(to, t);
  return Number.isFinite(mapped) ? mapped : index;
}
