import { configDefaults, defineConfig } from "vitest/config";

// 4つの子プロセスを実時間の5秒fenceで動かす回帰。fenceを延ばさず、並走の負荷から切り離して単独で走らせる
const REAL_TIME_PROCESS_TESTS = [
  "src/test/utils/gradleOwnedSourceProcess.test.ts",
  "src/test/utils/gradleOwnedAuthorityProcess.test.ts",
  "src/test/utils/gradleOwnedConsumerProcess.test.ts",
];
// 偽のosv-scannerの起動・多数のファイルの作成を伴うテストが、マシンの負荷(他のビルド等)で既定の5秒を超え、
// npm publishの事前テストが失敗した(2026-10-24、負荷平均23で6件)。止まったテストは30秒で失敗させる
const testTimeout = 30_000;

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "default",
          include: ["src/test/**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...REAL_TIME_PROCESS_TESTS],
          testTimeout,
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: "real-time-process",
          include: REAL_TIME_PROCESS_TESTS,
          testTimeout,
          maxWorkers: 1,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
