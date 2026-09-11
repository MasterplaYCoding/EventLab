/**
 * What every recipe hands the test: where the app is, and how to stop it.
 *
 * Nothing framework-specific survives past this interface, which is why the
 * EventLab scenario in `test/scenario.ts` is shared by all of them unchanged.
 */
export interface RunningApp {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}
