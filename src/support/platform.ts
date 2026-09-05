// Whether this process runs on Windows, as a value rather than a check made
// three times over. Every consumer takes it as a default parameter instead of
// reading process.platform for itself: the branch a given host cannot reach is
// still a branch the suite has to drive, and a constant read inline is one no
// test can enter.
export const RUNS_ON_WINDOWS: boolean = process.platform === "win32";
