import { BadRequestException } from "@nestjs/common";
import {
  defaultReviewWindow,
  formatLocalDate,
  resolveReviewWindow,
} from "./review-window";

describe("resolveReviewWindow", () => {
  const now = new Date(2026, 8, 23, 15, 30);

  it("defaults to the last 14 days", () => {
    expect(resolveReviewWindow({}, now)).toEqual({
      since: new Date(2026, 8, 9),
      days: 14,
    });
    expect(resolveReviewWindow({}, now)).toEqual(defaultReviewWindow(now));
  });

  it("uses ?days=N", () => {
    expect(resolveReviewWindow({ days: "3" }, now)).toEqual({
      since: new Date(2026, 8, 20),
      days: 3,
    });
  });

  it("parses ?since as local midnight", () => {
    const window = resolveReviewWindow({ since: "2026-09-01" }, now);
    expect(window).toEqual({ since: new Date(2026, 8, 1), days: null });
    expect(formatLocalDate(window.since!)).toBe("2026-09-01");
  });

  it("prefers since over days", () => {
    expect(resolveReviewWindow({ since: "2026-09-01", days: "3" }, now)).toEqual(
      { since: new Date(2026, 8, 1), days: null },
    );
  });

  it("prefers all over since and days", () => {
    expect(
      resolveReviewWindow({ all: "true", since: "2026-09-01", days: "3" }, now),
    ).toEqual({ since: null, days: null });
  });

  it("ignores all values other than 'true'", () => {
    expect(resolveReviewWindow({ all: "false" }, now)).toEqual(
      defaultReviewWindow(now),
    );
  });

  it.each(["0", "-1", "1.5", "abc", "1e3", " 7", "99999999999"])(
    "rejects days=%p with 400",
    (days) => {
      expect(() => resolveReviewWindow({ days }, now)).toThrow(
        BadRequestException,
      );
    },
  );

  it.each(["2026-9-1", "yesterday", "2026-02-31", "2026-13-01", "20260901"])(
    "rejects since=%p with 400",
    (since) => {
      expect(() => resolveReviewWindow({ since }, now)).toThrow(
        BadRequestException,
      );
    },
  );

  it("does not validate days when since or all wins", () => {
    expect(() =>
      resolveReviewWindow({ since: "2026-09-01", days: "abc" }, now),
    ).not.toThrow();
    expect(() =>
      resolveReviewWindow({ all: "true", since: "bad", days: "abc" }, now),
    ).not.toThrow();
  });
});
