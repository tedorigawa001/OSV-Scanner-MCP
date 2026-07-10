import { describe, expect, it } from "vitest";

import {
  ALLOWED_ROOT_ENV,
  REQUIRE_ALLOWED_ROOT_ENV,
  allowedRootStartupError,
  allowedRootStartupWarning,
} from "../../utils/startupConfig.js";

describe("allowedRootStartupError", () => {
  it("REQUIRE未設定なら常にnull(従来動作)", () => {
    expect(allowedRootStartupError({})).toBeNull();
    expect(allowedRootStartupError({ [ALLOWED_ROOT_ENV]: "/home/user/projects" })).toBeNull();
  });

  it("REQUIRE有効+ALLOWED_ROOT設定済みならnull", () => {
    expect(
      allowedRootStartupError({
        [REQUIRE_ALLOWED_ROOT_ENV]: "1",
        [ALLOWED_ROOT_ENV]: "/home/user/projects",
      }),
    ).toBeNull();
  });

  it("REQUIRE有効+ALLOWED_ROOT未設定はエラーメッセージを返す", () => {
    const error = allowedRootStartupError({ [REQUIRE_ALLOWED_ROOT_ENV]: "1" });
    expect(error).toContain(ALLOWED_ROOT_ENV);
    expect(error).toContain("起動を中止");
  });

  it("REQUIRE有効+ALLOWED_ROOTが空白のみもエラー", () => {
    expect(
      allowedRootStartupError({
        [REQUIRE_ALLOWED_ROOT_ENV]: "true",
        [ALLOWED_ROOT_ENV]: "   ",
      }),
    ).not.toBeNull();
  });

  it("REQUIREは1/true/yes(大文字小文字無視)を有効と解釈する", () => {
    for (const value of ["1", "true", "TRUE", "yes", "Yes"]) {
      expect(allowedRootStartupError({ [REQUIRE_ALLOWED_ROOT_ENV]: value })).not.toBeNull();
    }
    for (const value of ["0", "false", "no", "", "  "]) {
      expect(allowedRootStartupError({ [REQUIRE_ALLOWED_ROOT_ENV]: value })).toBeNull();
    }
  });
});

describe("allowedRootStartupWarning", () => {
  it("ALLOWED_ROOT未設定なら推奨設定を促す警告を返す", () => {
    const warning = allowedRootStartupWarning({});
    expect(warning).toContain(ALLOWED_ROOT_ENV);
    expect(warning).toContain("任意の絶対パス");
  });

  it("ALLOWED_ROOT設定済みならnull(警告なし)", () => {
    expect(
      allowedRootStartupWarning({ [ALLOWED_ROOT_ENV]: "/home/user/projects" }),
    ).toBeNull();
  });

  it("空白のみの設定は未設定と同様に警告する", () => {
    expect(allowedRootStartupWarning({ [ALLOWED_ROOT_ENV]: "  " })).not.toBeNull();
  });
});
