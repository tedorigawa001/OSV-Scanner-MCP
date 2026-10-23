import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/test/**/*.test.ts"],
    // 偽のosv-scannerの起動・多数のファイルの作成を伴うテストが、マシンの負荷(他のビルド等)で既定の5秒を超え、
    // npm publishの事前テストが失敗した(2026-10-24、負荷平均23で6件)。止まったテストは30秒で失敗させる
    testTimeout: 30_000,
  },
});
