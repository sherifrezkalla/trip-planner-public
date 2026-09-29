/** How far ahead the risk scan looks, and how far the request must reach to answer it. */
const HORIZON_HOURS = 6;

export type TodayWeather = {
  temperatureC: number;
  summary: string;
  maxPrecipitationProbability: number;
  /** The hour the provider is describing. */
  observedAt: string;
  /** When this reading was retrieved. Caching can put it well behind now. */
  fetchedAt: string;
  /** How many of the six horizon hours the scan actually had data for. */
  coverageHours: number;
  risk: "clear" | "watch" | "warning";
  riskMessage: string;
};

type OpenMeteoResponse = {
  current?: {
    time?: number;
    temperature_2m?: number;
    weather_code?: number;
    precipitation?: number;
  };
  hourly?: {
    time?: number[];
    precipitation_probability?: number[];
    weather_code?: number[];
  };
};

export function openMeteoUrl(lat: number, lng: number): string {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat.toString());
  url.searchParams.set("longitude", lng.toString());
  url.searchParams.set("current", "temperature_2m,weather_code,precipitation");
  url.searchParams.set("hourly", "precipitation_probability,weather_code");
  // Two days, not one. `timezone=auto` bounds the hourly array to the local
  // calendar day, so a single day leaves the evening with less than six hours
  // ahead of it — and a scan that runs out of hours reads exactly like a calm
  // one. The horizon filter below still stops at six hours.
  url.searchParams.set("forecast_days", "2");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("timeformat", "unixtime");
  return url.toString();
}

export function weatherCodeSummary(code: number): string {
  if (code === 0) return "Clear";
  if (code <= 3) return "Cloudy";
  if (code === 45 || code === 48) return "Foggy";
  if (code <= 57) return "Drizzle";
  if (code <= 67) return "Rain";
  if (code <= 77) return "Snow";
  if (code <= 82) return "Rain showers";
  if (code <= 86) return "Snow showers";
  if (code >= 95) return "Thunderstorms";
  return "Mixed weather";
}

/**
 * Normalize one provider response into what Today Mode shows.
 *
 * `fetchedAt` is supplied by the caller rather than read from the clock here:
 * the response may have been cached, and a timestamp taken at parse time would
 * claim a freshness the data does not have.
 */
export function parseTodayWeather(raw: unknown, fetchedAt: string): TodayWeather | null {
  const data = raw as OpenMeteoResponse;
  const current = data?.current;
  if (!current || !Number.isFinite(current.time) || !Number.isFinite(current.temperature_2m)
    || !Number.isFinite(current.weather_code)) return null;

  const currentTime = current.time!;
  const horizon = currentTime + HORIZON_HOURS * 60 * 60;
  const hourlyTimes = data.hourly?.time ?? [];
  const hourlyChance = data.hourly?.precipitation_probability ?? [];
  const hourlyCodes = data.hourly?.weather_code ?? [];
  let maxPrecipitationProbability = 0;
  let severeWeather = current.weather_code! >= 95;
  let seriesEnd = currentTime;

  for (let index = 0; index < hourlyTimes.length; index++) {
    if (Number.isFinite(hourlyTimes[index])) seriesEnd = Math.max(seriesEnd, hourlyTimes[index]);
    if (hourlyTimes[index] < currentTime || hourlyTimes[index] > horizon) continue;
    const chance = hourlyChance[index];
    const code = hourlyCodes[index];
    if (Number.isFinite(chance)) maxPrecipitationProbability = Math.max(maxPrecipitationProbability, chance);
    if (Number.isFinite(code)) severeWeather ||= code >= 95;
  }

  // Whether the series spans the horizon, not how far the last sample inside it
  // happened to fall. The provider timestamps current conditions to the quarter
  // hour while the hourly series sits on the hour, so the last sample inside the
  // window is normally short of it even when the series runs days past — asking
  // the second question makes coverage flap with the minute hand and warn about
  // a forecast that is complete. Short answers round down; never overstate.
  const coverageHours = seriesEnd >= horizon
    ? HORIZON_HOURS
    : Math.max(0, Math.floor((seriesEnd - currentTime) / 3600));

  const currentlyWet = (current.precipitation ?? 0) > 0 || current.weather_code! >= 51;
  const risk = severeWeather || maxPrecipitationProbability >= 70 ? "warning"
    : currentlyWet || maxPrecipitationProbability >= 40 ? "watch"
      : "clear";

  // A risk found inside a short window is still a real risk, so the shortfall
  // is only worth reporting when the scan found nothing — that is the case
  // where silence would otherwise be mistaken for good news.
  const riskMessage = severeWeather ? "Thunderstorms are possible in the next six hours"
    : maxPrecipitationProbability >= 70 ? `Rain is likely in the next six hours (${maxPrecipitationProbability}%)`
      : currentlyWet ? "Wet weather may affect the next activity"
        : maxPrecipitationProbability >= 40 ? `Keep a rain backup ready (${maxPrecipitationProbability}% chance)`
          : coverageHours < HORIZON_HOURS
            ? `Forecast only reaches ${coverageHours}h ahead — check a local forecast`
            : "No significant weather disruption detected";

  return {
    temperatureC: Math.round(current.temperature_2m!),
    summary: weatherCodeSummary(current.weather_code!),
    maxPrecipitationProbability,
    observedAt: new Date(currentTime * 1000).toISOString(),
    fetchedAt,
    coverageHours,
    risk,
    riskMessage,
  };
}

/** One trip day's outlook, used before departure rather than during. */
export type DayOutlook = {
  date: string;
  maxPrecipitationProbability: number;
  weatherCode: number;
  temperatureMaxC: number;
  severe: boolean;
};

/**
 * The daily forecast across a date range.
 *
 * Separate from the six-hour `current` scan on purpose: that one answers "should
 * we leave now", this one answers "is Monday going to be wet". Open-Meteo caps
 * usable skill at about sixteen days, and anything past three is indicative
 * rather than settled — see `FORECAST_CONFIDENT_DAYS`.
 */
export function dailyForecastUrl(
  lat: number, lng: number, startDate: string, endDate: string,
): string {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat.toString());
  url.searchParams.set("longitude", lng.toString());
  url.searchParams.set("daily", "weather_code,temperature_2m_max,precipitation_probability_max");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);
  return url.toString();
}

/** Beyond this many days ahead a forecast should be re-checked, not acted on twice. */
export const FORECAST_CONFIDENT_DAYS = 3;

/**
 * Whether a dated outlook sits outside the window we present as dependable.
 *
 * Trip day numbers cannot answer this: day zero may still be weeks away, while
 * day four may be tomorrow once the trip is underway. Compare UTC calendar
 * dates so the answer is stable throughout the day and matches the provider's
 * date-only daily forecast.
 */
export function isBeyondConfidentForecast(
  forecastDate: string,
  checkedAt: Date = new Date(),
): boolean {
  const checkedDate = Date.UTC(
    checkedAt.getUTCFullYear(),
    checkedAt.getUTCMonth(),
    checkedAt.getUTCDate(),
  );
  const forecastDay = Date.parse(`${forecastDate}T00:00:00Z`);
  return (forecastDay - checkedDate) / 86_400_000 > FORECAST_CONFIDENT_DAYS;
}

type DailyResponse = {
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    precipitation_probability_max?: (number | null)[];
  };
};

export function parseDailyForecast(raw: unknown): DayOutlook[] {
  const daily = (raw as DailyResponse)?.daily;
  const times = daily?.time ?? [];
  const codes = daily?.weather_code ?? [];
  const maxima = daily?.temperature_2m_max ?? [];
  const chances = daily?.precipitation_probability_max ?? [];
  const outlooks: DayOutlook[] = [];
  for (let index = 0; index < times.length; index++) {
    const code = codes[index];
    const temperature = maxima[index];
    if (!Number.isFinite(code) || !Number.isFinite(temperature)) continue;
    const chance = chances[index];
    outlooks.push({
      date: times[index],
      maxPrecipitationProbability: Number.isFinite(chance) ? (chance as number) : 0,
      weatherCode: code,
      temperatureMaxC: Math.round(temperature),
      severe: code >= 95,
    });
  }
  return outlooks;
}

/**
 * Whether a day is wet enough to move an outdoor activity indoors.
 *
 * Deliberately higher than the six-hour "watch" threshold. That one asks a group
 * already on the ground to carry an umbrella; this one asks them to give up a
 * coastal path they chose, which needs more than a chance of drizzle.
 */
export function dayThreatensOutdoorPlans(outlook: DayOutlook): boolean {
  return outlook.severe || outlook.maxPrecipitationProbability >= 60 || outlook.weatherCode >= 61;
}
