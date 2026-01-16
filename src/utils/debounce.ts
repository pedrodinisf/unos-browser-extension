// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFunction = (...args: any[]) => any;

interface DebounceOptions {
  /** Call on the leading edge (default: false) */
  leading?: boolean;
  /** Call on the trailing edge (default: true) */
  trailing?: boolean;
  /** Maximum time to wait before forcing invocation */
  maxWait?: number;
}

interface DebouncedFunction<T extends AnyFunction> {
  (...args: Parameters<T>): void;
  /** Cancel pending invocation */
  cancel: () => void;
  /** Immediately invoke pending call */
  flush: () => void;
  /** Check if there's a pending invocation */
  pending: () => boolean;
}

/**
 * Creates a debounced function that delays invoking func until after
 * wait milliseconds have elapsed since the last time the debounced
 * function was invoked.
 */
export function debounce<T extends AnyFunction>(
  func: T,
  wait: number,
  options: DebounceOptions = {}
): DebouncedFunction<T> {
  const { leading = false, trailing = true, maxWait } = options;

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;
  let lastCallTime: number | undefined;
  let lastInvokeTime = 0;
  let result: ReturnType<T> | undefined;

  function invokeFunc(time: number): ReturnType<T> | undefined {
    const args = lastArgs;
    lastArgs = null;
    lastInvokeTime = time;

    if (args) {
      result = func(...args) as ReturnType<T>;
    }
    return result;
  }

  function shouldInvoke(time: number): boolean {
    const timeSinceLastCall = lastCallTime === undefined ? 0 : time - lastCallTime;
    const timeSinceLastInvoke = time - lastInvokeTime;

    return (
      lastCallTime === undefined ||
      timeSinceLastCall >= wait ||
      timeSinceLastCall < 0 ||
      (maxWait !== undefined && timeSinceLastInvoke >= maxWait)
    );
  }

  function remainingWait(time: number): number {
    const timeSinceLastCall = lastCallTime === undefined ? 0 : time - lastCallTime;
    const timeSinceLastInvoke = time - lastInvokeTime;
    const timeWaiting = wait - timeSinceLastCall;

    return maxWait === undefined
      ? timeWaiting
      : Math.min(timeWaiting, maxWait - timeSinceLastInvoke);
  }

  function timerExpired(): void {
    const time = Date.now();

    if (shouldInvoke(time)) {
      return trailingEdge(time);
    }

    timeoutId = setTimeout(timerExpired, remainingWait(time));
  }

  function leadingEdge(time: number): void {
    lastInvokeTime = time;
    timeoutId = setTimeout(timerExpired, wait);

    if (leading) {
      invokeFunc(time);
    }
  }

  function trailingEdge(time: number): void {
    timeoutId = null;

    if (trailing && lastArgs) {
      invokeFunc(time);
    }
    lastArgs = null;
  }

  function cancel(): void {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    lastInvokeTime = 0;
    lastArgs = null;
    lastCallTime = undefined;
    timeoutId = null;
  }

  function flush(): void {
    if (timeoutId === null) {
      return;
    }
    trailingEdge(Date.now());
  }

  function pending(): boolean {
    return timeoutId !== null;
  }

  function debounced(...args: Parameters<T>): void {
    const time = Date.now();
    const isInvoking = shouldInvoke(time);

    lastArgs = args;
    lastCallTime = time;

    if (isInvoking) {
      if (timeoutId === null) {
        leadingEdge(time);
        return;
      }

      if (maxWait !== undefined) {
        timeoutId = setTimeout(timerExpired, wait);
        invokeFunc(time);
        return;
      }
    }

    if (timeoutId === null) {
      timeoutId = setTimeout(timerExpired, wait);
    }
  }

  debounced.cancel = cancel;
  debounced.flush = flush;
  debounced.pending = pending;

  return debounced;
}

/**
 * Creates a throttled function that only invokes func at most once
 * per every wait milliseconds.
 */
export function throttle<T extends AnyFunction>(
  func: T,
  wait: number,
  options: { leading?: boolean; trailing?: boolean } = {}
): DebouncedFunction<T> {
  return debounce(func, wait, {
    leading: options.leading ?? true,
    trailing: options.trailing ?? true,
    maxWait: wait,
  });
}
