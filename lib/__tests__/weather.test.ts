import { describe, expect, it } from "vitest";
import { openMeteoUrl, parseTodayWeather, weatherCodeSummary } from "@/lib/weather";

const FETCHED_AT = "2026-08-12T07:42:31.000Z";

describe("Today weather", () => {
  it("requests only the current and six-hour risk inputs", () => {
    const url = new URL(openMeteoUrl(40.7, -74));
    expect(url.hostname).toBe("api.open-meteo.com");
    expect(url.searchParams.get("current")).toContain("weather_code");
    expect(url.searchParams.get("hourly")).toContain("precipitation_probability");
    expect(url.searchParams.get("timeformat")).toBe("unixtime");
  });

  /**
   * `timezone=auto` bounds the hourly array to the *local* calendar day, so one
   * forecast day leaves the evening with fewer than six hours ahead of it. The
   * request must reach into tomorrow for the six-hour scan to be answerable at
   * all after 18:00 local.
   */
  it("asks for enough days that the six-hour scan survives local midnight", () => {
    expect(new URL(openMeteoUrl(43.55, 7.02)).searchParams.get("forecast_days")).toBe("2");
  });

  it("turns a high rain probability into a visible warning", () => {
    const currentTime = 1_786_444_800;
    const weather = parseTodayWeather({
      current: { time: currentTime, temperature_2m: 23.6, weather_code: 2, precipitation: 0 },
      hourly: {
        time: [currentTime, currentTime + 3600, currentTime + 7200],
        precipitation_probability: [10, 45, 80],
        weather_code: [2, 51, 63],
      },
    }, FETCHED_AT);
    expect(weather).toMatchObject({
      temperatureC: 24,
      summary: "Cloudy",
      maxPrecipitationProbability: 80,
      risk: "warning",
      riskMessage: "Rain is likely in the next six hours (80%)",
    });
  });

  it("prioritizes thunderstorm risk over rain probability", () => {
    const currentTime = 1_786_444_800;
    expect(parseTodayWeather({
      current: { time: currentTime, temperature_2m: 18, weather_code: 3, precipitation: 0 },
      hourly: {
        time: [currentTime + 3600],
        precipitation_probability: [20],
        weather_code: [95],
      },
    }, FETCHED_AT)).toMatchObject({
      risk: "warning",
      riskMessage: "Thunderstorms are possible in the next six hours",
    });
  });

  it("fails closed when required provider fields are missing", () => {
    expect(parseTodayWeather({ current: { temperature_2m: 20 } }, FETCHED_AT)).toBeNull();
  });

  it("maps the provider weather codes to concise labels", () => {
    expect(weatherCodeSummary(0)).toBe("Clear");
    expect(weatherCodeSummary(63)).toBe("Rain");
    expect(weatherCodeSummary(95)).toBe("Thunderstorms");
  });

  it("reports full coverage when the provider answers the whole horizon", () => {
    const currentTime = 1_786_444_800;
    const time = Array.from({ length: 12 }, (_, h) => currentTime + h * 3600);
    expect(parseTodayWeather({
      current: { time: currentTime, temperature_2m: 21, weather_code: 1, precipitation: 0 },
      hourly: {
        time,
        precipitation_probability: time.map(() => 5),
        weather_code: time.map(() => 1),
      },
    }, FETCHED_AT)).toMatchObject({ coverageHours: 6, riskMessage: "No significant weather disruption detected" });
  });

  /**
   * A short forecast used to be indistinguishable from a calm one: the scan
   * skipped the hours it did not have and reported "no disruption" into an
   * oncoming storm. Absence of data must read as absence of data.
   */
  it("says the scan fell short rather than claiming calm weather", () => {
    const currentTime = 1_786_444_800;
    const time = [currentTime, currentTime + 3600, currentTime + 7200];
    const weather = parseTodayWeather({
      current: { time: currentTime, temperature_2m: 19, weather_code: 2, precipitation: 0 },
      hourly: {
        time,
        precipitation_probability: time.map(() => 5),
        weather_code: time.map(() => 2),
      },
    }, FETCHED_AT);

    expect(weather).toMatchObject({ coverageHours: 2, risk: "clear" });
    expect(weather!.riskMessage).toBe("Forecast only reaches 2h ahead — check a local forecast");
  });

  /** A real risk inside a short window is still a real risk; say both. */
  it("still warns on a risk found inside a short window", () => {
    const currentTime = 1_786_444_800;
    const time = [currentTime, currentTime + 3600];
    expect(parseTodayWeather({
      current: { time: currentTime, temperature_2m: 19, weather_code: 2, precipitation: 0 },
      hourly: { time, precipitation_probability: [10, 85], weather_code: [2, 63] },
    }, FETCHED_AT)).toMatchObject({
      coverageHours: 1,
      risk: "warning",
      riskMessage: "Rain is likely in the next six hours (85%)",
    });
  });

  /**
   * The provider timestamps current conditions to the quarter hour while the
   * hourly series sits on the hour, so the last sample *inside* the window is
   * normally short of it even when the series runs days past. Coverage asks
   * whether the data spans the horizon, not how far the last sample inside it
   * happened to fall — otherwise it flaps between 5 and 6 with the minute hand
   * and cries wolf on a forecast that is entirely complete.
   */
  it("reports full coverage when the series outruns the horizon off-grid", () => {
    const hourGrid = 1_786_444_800;
    const currentTime = hourGrid + 45 * 60; // provider clock at :45 past
    const time = Array.from({ length: 48 }, (_, h) => hourGrid + h * 3600);
    const weather = parseTodayWeather({
      current: { time: currentTime, temperature_2m: 29, weather_code: 2, precipitation: 0 },
      hourly: {
        time,
        precipitation_probability: time.map(() => 0),
        weather_code: time.map(() => 2),
      },
    }, FETCHED_AT);

    expect(weather).toMatchObject({
      coverageHours: 6,
      riskMessage: "No significant weather disruption detected",
    });
  });

  /**
   * `observedAt` names the hour the provider is describing; `fetchedAt` names
   * when we retrieved it. Caching separates the two by up to 45 minutes, so the
   * UI cannot present one as the other.
   */
  it("separates the hour described from the moment retrieved", () => {
    const currentTime = 1_786_444_800;
    const weather = parseTodayWeather({
      current: { time: currentTime, temperature_2m: 20, weather_code: 0, precipitation: 0 },
      hourly: { time: [], precipitation_probability: [], weather_code: [] },
    }, FETCHED_AT);

    expect(weather!.observedAt).toBe(new Date(currentTime * 1000).toISOString());
    expect(weather!.fetchedAt).toBe(FETCHED_AT);
  });
});
