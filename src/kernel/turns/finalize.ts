export interface TurnFinalizationStep {
  name: string
  run: () => void | Promise<void>
}

/** Run every finalization step even when one fails. A fire-and-forget turn must
 * never turn a local persistence error into an unhandled daemon rejection. */
export async function runTurnFinalization(steps: TurnFinalizationStep[]): Promise<unknown[]> {
  const errors: unknown[] = []
  for (const step of steps) {
    try {
      await step.run()
    } catch (error) {
      errors.push(error)
      console.error(`[engine] turn finalization failed during ${step.name}:`, error)
    }
  }
  return errors
}
