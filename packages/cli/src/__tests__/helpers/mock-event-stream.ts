/**
 * Controllable async generator for testing ChatApp event processing.
 *
 * Unlike the static factories in factories.ts, this creates a generator
 * where you can emit events one at a time with precise timing control.
 */

interface ControllableStream {
  /**
   * Returns the async generator to pass as onSendMessage.
   */
  stream: (text: string) => AsyncGenerator<any>;
  /**
   * Emit an event into the stream. Resolves when the event is yielded.
   */
  emit: (event: any) => void;
  /**
   * End the stream (emits a done event).
   */
  finish: (totalCost?: number) => void;
}

/**
 * Create a controllable event stream for testing.
 *
 * Usage:
 * ```ts
 * const ctl = createControllableStream();
 * const { stdin } = render(<ChatApp onSendMessage={ctl.stream} />);
 * stdin.write('hello\r'); // submit
 * ctl.emit({ type: 'text-delta', delta: 'Hi!' });
 * ctl.finish(0.001);
 * ```
 */
export function createControllableStream(): ControllableStream {
  let resolveNext: ((event: any) => void) | null = null;
  let done = false;

  const stream = async function* () {
    while (!done) {
      const event = await new Promise<any>((resolve) => {
        resolveNext = resolve;
      });
      yield event;
      if (event.type === "done") {
        done = true;
        return;
      }
    }
  };

  return {
    stream: () => stream(),
    emit: (event: any) => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(event);
      }
    },
    finish: (totalCost = 0) => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        done = true;
        r({ type: "done", totalCost });
      }
    },
  };
}
