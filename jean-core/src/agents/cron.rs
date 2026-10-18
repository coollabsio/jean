//! Five-field cron expressions, evaluated in an IANA timezone.
//!
//! Day-of-month and day-of-week follow standard cron: if both are restricted,
//! a date matches when either field matches. The next run is strictly after
//! the given instant. Spring-forward gaps are skipped. Fall-back hours match
//! once per real instant, earlier offset first.

use std::str::FromStr;

use chrono::{
    DateTime, Datelike, LocalResult, NaiveDate, NaiveDateTime, TimeDelta, TimeZone, Timelike,
};
use chrono_tz::Tz;

/// Repeating schedules cannot run closer together than this.
pub const MIN_SPACING_SECS: i64 = 300;
/// 30 days, the same limit as the MCP `delayMinutes` / `everyMinutes`.
const MAX_INTERVAL_SECS: i64 = 60 * 60 * 24 * 30;
const SEARCH_MINUTES: i64 = 366 * 4 * 24 * 60;

/// A parsed 5-field cron expression.
#[derive(Debug, Clone, PartialEq)]
pub struct CronExpr {
    minutes: [bool; 60],
    hours: [bool; 24],
    /// Index 1..=31.
    dom: [bool; 32],
    /// Index 1..=12.
    months: [bool; 13],
    /// 0 = Sunday … 6 = Saturday.
    dow: [bool; 7],
    dom_star: bool,
    dow_star: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AcceptedCron {
    pub expression: String,
    pub timezone: String,
    pub next_run_at: i64,
}

/// Parse, check the 5-minute floor, and compute the next run after `now_unix`.
pub fn accept(
    expression: &str,
    timezone: Option<&str>,
    now_unix: i64,
) -> Result<AcceptedCron, String> {
    let expression = normalize_expression(expression);
    let expr = parse(&expression)?;
    let timezone = timezone
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("UTC");
    let tz = parse_timezone(timezone)?;
    validate_spacing(&expr, tz)?;
    let next_run_at = next_run(&expr, now_unix, tz)?;
    Ok(AcceptedCron {
        expression,
        timezone: tz.name().to_string(),
        next_run_at,
    })
}

/// Next run of an already stored expression. Used when a cron schedule fires.
pub fn next_after(expression: &str, timezone: &str, after_unix: i64) -> Result<i64, String> {
    let expr = parse(expression)?;
    let tz = parse_timezone(timezone)?;
    next_run(&expr, after_unix, tz)
}

pub fn max_interval_secs() -> i64 {
    MAX_INTERVAL_SECS
}

fn normalize_expression(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn parse_timezone(name: &str) -> Result<Tz, String> {
    if let Ok(tz) = Tz::from_str(name) {
        return Ok(tz);
    }
    if let Some(tz) = chrono_tz::TZ_VARIANTS
        .iter()
        .find(|tz| tz.name().eq_ignore_ascii_case(name))
    {
        return Ok(*tz);
    }
    Err(format!(
        "Unknown timezone '{name}'. Use an IANA name such as UTC or America/New_York."
    ))
}

fn parse(input: &str) -> Result<CronExpr, String> {
    let fields: Vec<&str> = input.split(' ').filter(|field| !field.is_empty()).collect();
    if fields.len() != 5 {
        return Err(
            "Cron must have 5 fields: minute hour day-of-month month day-of-week".to_string(),
        );
    }
    let minutes = parse_field(fields[0], 0, 59, &[])?;
    let hours = parse_field(fields[1], 0, 23, &[])?;
    let (dom, dom_star) = parse_field_star(fields[2], 1, 31, &[])?;
    let months = parse_field(fields[3], 1, 12, MONTHS)?;
    let (dow_raw, dow_star) = parse_field_star(fields[4], 0, 7, DOWS)?;
    let mut dow = [false; 7];
    for value in dow_raw {
        let day = if value == 7 { 0 } else { value };
        if day > 6 {
            return Err(format!("Invalid day-of-week '{value}': expected 0-7"));
        }
        dow[day as usize] = true;
    }
    if !dow.iter().any(|on| *on) {
        return Err("Day-of-week field matches nothing".to_string());
    }
    Ok(CronExpr {
        minutes: bits(60, &minutes)?,
        hours: bits(24, &hours)?,
        dom: bits(32, &dom)?,
        months: bits(13, &months)?,
        dow,
        dom_star,
        dow_star,
    })
}

fn bits<const N: usize>(len: usize, values: &[u32]) -> Result<[bool; N], String> {
    if len != N {
        return Err("internal cron field size mismatch".to_string());
    }
    let mut out = [false; N];
    for value in values {
        let index = *value as usize;
        if index >= N {
            return Err(format!("Cron value {value} is out of range"));
        }
        out[index] = true;
    }
    if !out.iter().any(|on| *on) {
        return Err("Cron field matches nothing".to_string());
    }
    Ok(out)
}

fn parse_field(field: &str, min: u32, max: u32, names: &[(&str, u32)]) -> Result<Vec<u32>, String> {
    Ok(parse_field_star(field, min, max, names)?.0)
}

fn parse_field_star(
    field: &str,
    min: u32,
    max: u32,
    names: &[(&str, u32)],
) -> Result<(Vec<u32>, bool), String> {
    let field = field.trim();
    if field.is_empty() {
        return Err("Cron field is empty".to_string());
    }
    if field.contains('?') {
        return Err("Cron '?' is not supported. Use '*'.".to_string());
    }
    let star = field == "*";
    let mut values = Vec::new();
    for part in field.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return Err(format!("Invalid cron field '{field}'"));
        }
        let (range, step) = match part.split_once('/') {
            Some((range, step)) => {
                let step = step
                    .parse::<u32>()
                    .map_err(|_| format!("Invalid cron step '{step}'"))?;
                if step == 0 {
                    return Err("Cron step must be 1 or more".to_string());
                }
                (range, Some(step))
            }
            None => (part, None),
        };
        let (start, end) = if range == "*" {
            (min, max)
        } else if let Some((start, end)) = range.split_once('-') {
            (
                parse_token(start, min, max, names)?,
                parse_token(end, min, max, names)?,
            )
        } else {
            let value = parse_token(range, min, max, names)?;
            // `N/step` means `N-max/step`, as in cronie.
            (value, if step.is_some() { max } else { value })
        };
        let step = step.unwrap_or(1);
        if start > end {
            return Err(format!("Cron range {start}-{end} is reversed"));
        }
        let mut value = start;
        loop {
            if value > end {
                break;
            }
            values.push(value);
            match value.checked_add(step) {
                Some(next) => value = next,
                None => break,
            }
        }
    }
    Ok((values, star))
}

fn parse_token(token: &str, min: u32, max: u32, names: &[(&str, u32)]) -> Result<u32, String> {
    let token = token.trim();
    if let Ok(value) = token.parse::<u32>() {
        if (min..=max).contains(&value) {
            return Ok(value);
        }
        return Err(format!("Cron value '{token}' is outside {min}-{max}"));
    }
    let upper = token.to_ascii_uppercase();
    if let Some((_, value)) = names.iter().find(|(name, _)| *name == upper) {
        return Ok(*value);
    }
    Err(format!("Invalid cron value '{token}'"))
}

const MONTHS: &[(&str, u32)] = &[
    ("JAN", 1),
    ("FEB", 2),
    ("MAR", 3),
    ("APR", 4),
    ("MAY", 5),
    ("JUN", 6),
    ("JUL", 7),
    ("AUG", 8),
    ("SEP", 9),
    ("OCT", 10),
    ("NOV", 11),
    ("DEC", 12),
];

const DOWS: &[(&str, u32)] = &[
    ("SUN", 0),
    ("MON", 1),
    ("TUE", 2),
    ("WED", 3),
    ("THU", 4),
    ("FRI", 5),
    ("SAT", 6),
];

fn next_run(expr: &CronExpr, after_unix: i64, tz: Tz) -> Result<i64, String> {
    let start = match tz.timestamp_opt(after_unix, 0) {
        LocalResult::Single(dt) => dt,
        LocalResult::Ambiguous(early, late) => {
            if early.timestamp() == after_unix {
                early
            } else {
                late
            }
        }
        LocalResult::None => {
            return Err("Timestamp does not exist in this timezone".to_string());
        }
    };
    // Stay on this wall-clock minute. A fall-back hour has two real instants
    // for the same minute, and the later one can still be in the future.
    let mut local = truncate_minute(start.naive_local())?;
    // In the earlier pass of a fall-back hour, the rest of that pass comes
    // first, then the whole hour again in the later offset.
    if let LocalResult::Ambiguous(early, _) = tz.from_local_datetime(&local) {
        if (0..60).contains(&(after_unix - early.timestamp())) {
            if let Some(unix) = next_in_early_pass(expr, &tz, local)? {
                return Ok(unix);
            }
            local = overlap_start(&tz, local)?;
        }
    }
    // Every step below moves `local` forward, so a wall-clock limit ends the
    // search even when the fields never line up (for example February 31).
    let limit = add_minutes(local, SEARCH_MINUTES)?;
    while local <= limit {
        if !expr.months[local.month() as usize] {
            local = next_month_start(local, expr)?;
            continue;
        }
        if !day_matches(expr, local.date()) {
            local = next_day_start(local)?;
            continue;
        }
        if !expr.hours[local.hour() as usize] {
            local = next_hour(local, expr)?;
            continue;
        }
        if !expr.minutes[local.minute() as usize] {
            local = next_minute(local, expr)?;
            continue;
        }
        match resolve_after(&tz, local, after_unix) {
            Resolved::At(unix) => return Ok(unix),
            Resolved::Skip => local = add_minutes(local, 1)?,
        }
    }
    Err("Cron expression has no run in the next 4 years".to_string())
}

fn matches(expr: &CronExpr, local: NaiveDateTime) -> bool {
    expr.months[local.month() as usize]
        && day_matches(expr, local.date())
        && expr.hours[local.hour() as usize]
        && expr.minutes[local.minute() as usize]
}

/// First match after `local` that is still in the earlier pass of the overlap.
fn next_in_early_pass(
    expr: &CronExpr,
    tz: &Tz,
    local: NaiveDateTime,
) -> Result<Option<i64>, String> {
    let mut wall = add_minutes(local, 1)?;
    while let LocalResult::Ambiguous(early, _) = tz.from_local_datetime(&wall) {
        if matches(expr, wall) {
            return Ok(Some(early.timestamp()));
        }
        wall = add_minutes(wall, 1)?;
    }
    Ok(None)
}

/// First wall-clock minute of the fall-back overlap that contains `local`.
fn overlap_start(tz: &Tz, local: NaiveDateTime) -> Result<NaiveDateTime, String> {
    let mut wall = local;
    loop {
        let previous = add_minutes(wall, -1)?;
        if !matches!(
            tz.from_local_datetime(&previous),
            LocalResult::Ambiguous(..)
        ) {
            return Ok(wall);
        }
        wall = previous;
    }
}

fn day_matches(expr: &CronExpr, date: NaiveDate) -> bool {
    let dom_ok = expr.dom[date.day() as usize];
    let dow_ok = expr.dow[date.weekday().num_days_from_sunday() as usize];
    match (expr.dom_star, expr.dow_star) {
        (true, true) => true,
        (false, true) => dom_ok,
        (true, false) => dow_ok,
        (false, false) => dom_ok || dow_ok,
    }
}

enum Resolved {
    At(i64),
    Skip,
}

fn resolve_after(tz: &Tz, local: NaiveDateTime, after_unix: i64) -> Resolved {
    match tz.from_local_datetime(&local) {
        LocalResult::None => Resolved::Skip,
        LocalResult::Single(dt) => after_instant(dt, after_unix),
        LocalResult::Ambiguous(early, late) => {
            if early.timestamp() > after_unix {
                Resolved::At(early.timestamp())
            } else if late.timestamp() > after_unix {
                Resolved::At(late.timestamp())
            } else {
                Resolved::Skip
            }
        }
    }
}

fn after_instant<T: TimeZone>(dt: DateTime<T>, after_unix: i64) -> Resolved {
    if dt.timestamp() > after_unix {
        Resolved::At(dt.timestamp())
    } else {
        Resolved::Skip
    }
}

fn truncate_minute(local: NaiveDateTime) -> Result<NaiveDateTime, String> {
    local
        .with_second(0)
        .and_then(|value| value.with_nanosecond(0))
        .ok_or_else(|| "Failed to truncate the cron clock".to_string())
}

fn add_minutes(local: NaiveDateTime, minutes: i64) -> Result<NaiveDateTime, String> {
    let delta = TimeDelta::try_minutes(minutes).ok_or_else(|| "Cron clock overflow".to_string())?;
    local
        .checked_add_signed(delta)
        .ok_or_else(|| "Cron clock overflow".to_string())
}

fn next_day_start(local: NaiveDateTime) -> Result<NaiveDateTime, String> {
    let delta = TimeDelta::try_days(1).ok_or_else(|| "Cron clock overflow".to_string())?;
    let date = local
        .date()
        .checked_add_signed(delta)
        .ok_or_else(|| "Cron clock overflow".to_string())?;
    date.and_hms_opt(0, 0, 0)
        .ok_or_else(|| "Cron clock overflow".to_string())
}

fn next_month_start(local: NaiveDateTime, expr: &CronExpr) -> Result<NaiveDateTime, String> {
    let mut year = local.year();
    let mut month = local.month();
    for _ in 0..48 {
        month += 1;
        if month > 12 {
            month = 1;
            year += 1;
        }
        if expr.months[month as usize] {
            return NaiveDate::from_ymd_opt(year, month, 1)
                .and_then(|date| date.and_hms_opt(0, 0, 0))
                .ok_or_else(|| "Cron clock overflow".to_string());
        }
    }
    Err("Cron expression has no matching month".to_string())
}

fn next_hour(local: NaiveDateTime, expr: &CronExpr) -> Result<NaiveDateTime, String> {
    let date = local.date();
    if let Some(hour) = ((local.hour() + 1)..24).find(|hour| expr.hours[*hour as usize]) {
        return date
            .and_hms_opt(hour, 0, 0)
            .ok_or_else(|| "Cron clock overflow".to_string());
    }
    let start = next_day_start(local)?;
    let hour = (0..24)
        .find(|hour| expr.hours[*hour as usize])
        .ok_or_else(|| "Cron hour field matches nothing".to_string())?;
    start
        .date()
        .and_hms_opt(hour, 0, 0)
        .ok_or_else(|| "Cron clock overflow".to_string())
}

fn next_minute(local: NaiveDateTime, expr: &CronExpr) -> Result<NaiveDateTime, String> {
    if let Some(minute) = ((local.minute() + 1)..60).find(|minute| expr.minutes[*minute as usize]) {
        return local
            .with_minute(minute)
            .and_then(|value| value.with_second(0))
            .and_then(|value| value.with_nanosecond(0))
            .ok_or_else(|| "Cron clock overflow".to_string());
    }
    let rolled = local
        .with_minute(0)
        .and_then(|value| value.with_second(0))
        .ok_or_else(|| "Cron clock overflow".to_string())?;
    add_minutes(rolled, 60)
}

fn validate_spacing(expr: &CronExpr, tz: Tz) -> Result<(), String> {
    let anchor = match Tz::UTC.with_ymd_and_hms(2026, 1, 1, 0, 0, 0) {
        LocalResult::Single(dt) => dt.timestamp() - 1,
        _ => return Err("Failed to build the cron spacing window".to_string()),
    };
    let mut prev = next_run(expr, anchor, tz)?;
    let window_end = prev + 400 * 86_400;
    let mut checks = 0;
    while checks < 200_000 {
        let next = next_run(expr, prev, tz)?;
        let gap = next - prev;
        if gap < MIN_SPACING_SECS {
            return Err(format!(
                "Cron runs {gap} seconds apart. The minimum spacing is {MIN_SPACING_SECS} seconds (5 minutes)."
            ));
        }
        if next > window_end {
            return Ok(());
        }
        prev = next;
        checks += 1;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Weekday;

    fn tz(name: &str) -> Tz {
        parse_timezone(name).unwrap()
    }

    fn at(zone: Tz, year: i32, month: u32, day: u32, hour: u32, minute: u32) -> i64 {
        match zone.with_ymd_and_hms(year, month, day, hour, minute, 0) {
            LocalResult::Single(dt) => dt.timestamp(),
            other => panic!("expected a single instant, got {other:?}"),
        }
    }

    fn local(zone: Tz, unix: i64) -> DateTime<Tz> {
        match zone.timestamp_opt(unix, 0) {
            LocalResult::Single(dt) => dt,
            other => panic!("expected a single instant, got {other:?}"),
        }
    }

    #[test]
    fn parses_ranges_lists_steps_and_names() {
        let expr = parse("*/15 0,6,12,18 1-7 JAN MON-FRI").unwrap();
        assert!(expr.minutes[0] && expr.minutes[15] && expr.minutes[45] && !expr.minutes[5]);
        assert!(expr.hours[0] && expr.hours[18] && !expr.hours[1]);
        assert!(expr.dom[1] && expr.dom[7] && !expr.dom[8]);
        assert!(expr.months[1] && !expr.months[2]);
        assert!(expr.dow[1] && expr.dow[5] && !expr.dow[0]);
        let from_zero = parse("0/15 * * * *").unwrap();
        let minutes: Vec<usize> = (0..60).filter(|m| from_zero.minutes[*m]).collect();
        assert_eq!(minutes, vec![0, 15, 30, 45]);
        let from_ten = parse("0 10/6 * * *").unwrap();
        let hours: Vec<usize> = (0..24).filter(|h| from_ten.hours[*h]).collect();
        assert_eq!(hours, vec![10, 16, 22]);
        let sunday = parse("0 0 * * 7").unwrap();
        assert!(sunday.dow[0] && !sunday.dow[1]);
    }

    #[test]
    fn rejects_bad_expressions_with_reasons() {
        assert!(parse("* * *").unwrap_err().contains("5 fields"));
        assert!(parse("60 * * * *").unwrap_err().contains("outside 0-59"));
        assert!(parse("*/0 * * * *").unwrap_err().contains("step"));
        assert!(parse("10-1 * * * *").unwrap_err().contains("reversed"));
        assert!(parse("0 0 * * ?").unwrap_err().contains("'?'"));
        assert!(parse("0 0 * * NOPE").unwrap_err().contains("NOPE"));
        let feb_31 = accept("0 0 31 2 *", Some("UTC"), 0).unwrap_err();
        assert!(feb_31.contains("no run in the next 4 years"), "{feb_31}");
        assert!(parse_timezone("Not/AZone")
            .unwrap_err()
            .contains("Unknown timezone"));
    }

    #[test]
    fn next_run_is_strictly_after_and_uses_the_timezone() {
        let zone = tz("UTC");
        let expr = parse("0 0 * * *").unwrap();
        let midnight = at(zone, 2026, 1, 1, 0, 0);
        let next = next_run(&expr, midnight, zone).unwrap();
        assert_eq!(next, at(zone, 2026, 1, 2, 0, 0));
        let before = at(zone, 2025, 12, 31, 23, 59);
        assert_eq!(next_run(&expr, before, zone).unwrap(), midnight);

        let india = tz("Asia/Kolkata");
        let morning = at(india, 2026, 6, 15, 0, 0);
        let half = next_run(&parse("30 0 * * *").unwrap(), morning, india).unwrap();
        let shown = local(india, half);
        assert_eq!(
            shown.date_naive(),
            NaiveDate::from_ymd_opt(2026, 6, 15).unwrap()
        );
        assert_eq!((shown.hour(), shown.minute()), (0, 30));
    }

    #[test]
    fn weekdays_and_dom_dow_or() {
        let zone = tz("UTC");
        let friday_morning = at(zone, 2026, 1, 2, 9, 0);
        let next = next_run(&parse("0 9 * * 1-5").unwrap(), friday_morning, zone).unwrap();
        let shown = local(zone, next);
        assert_eq!(shown.weekday(), Weekday::Mon);
        assert_eq!((shown.hour(), shown.minute()), (9, 0));
        assert_eq!(
            shown.date_naive(),
            NaiveDate::from_ymd_opt(2026, 1, 5).unwrap()
        );

        let named = next_run(&parse("0 9 * * MON-FRI").unwrap(), friday_morning, zone).unwrap();
        assert_eq!(named, next);

        // 2026-01-01 is a Thursday, so day-of-month 1 matches before the next Monday.
        let year_end = at(zone, 2025, 12, 31, 12, 0);
        let either = next_run(&parse("0 0 1 * 1").unwrap(), year_end, zone).unwrap();
        assert_eq!(either, at(zone, 2026, 1, 1, 0, 0));
    }

    #[test]
    fn spring_forward_skips_the_missing_hour() {
        let zone = tz("America/New_York");
        let missing = NaiveDate::from_ymd_opt(2026, 3, 8)
            .unwrap()
            .and_hms_opt(2, 30, 0)
            .unwrap();
        assert!(matches!(
            zone.from_local_datetime(&missing),
            LocalResult::None
        ));

        let before = at(zone, 2026, 3, 8, 1, 0);
        let next = next_run(&parse("30 2 * * *").unwrap(), before, zone).unwrap();
        let shown = local(zone, next);
        assert_eq!(
            shown.date_naive(),
            NaiveDate::from_ymd_opt(2026, 3, 9).unwrap()
        );
        assert_eq!((shown.hour(), shown.minute()), (2, 30));

        // 1:59 EST and 3:00 EDT are one real minute apart on this day.
        let gap = next_run(&parse("59,0 1,3 * * *").unwrap(), before, zone).unwrap();
        let err = accept("59,0 1,3 * * *", Some("America/New_York"), before).unwrap_err();
        assert!(err.contains("5 minutes"), "{err}");
        assert!(gap > before);
    }

    #[test]
    fn fall_back_runs_each_real_instant() {
        let zone = tz("America/New_York");
        let wall = NaiveDate::from_ymd_opt(2026, 11, 1)
            .unwrap()
            .and_hms_opt(1, 30, 0)
            .unwrap();
        let (early, late) = match zone.from_local_datetime(&wall) {
            LocalResult::Ambiguous(early, late) => (early, late),
            other => panic!("expected the overlap, got {other:?}"),
        };
        assert!(late.timestamp() - early.timestamp() > 300);
        let expr = parse("30 1 * * *").unwrap();
        assert_eq!(
            next_run(&expr, early.timestamp() - 60, zone).unwrap(),
            early.timestamp()
        );
        assert_eq!(
            next_run(&expr, early.timestamp(), zone).unwrap(),
            late.timestamp()
        );
        let after_overlap = next_run(&expr, late.timestamp(), zone).unwrap();
        let shown = local(zone, after_overlap);
        assert_eq!(
            shown.date_naive(),
            NaiveDate::from_ymd_opt(2026, 11, 2).unwrap()
        );
        assert_eq!((shown.hour(), shown.minute()), (1, 30));
    }

    #[test]
    fn fall_back_keeps_every_slot_in_both_passes() {
        let zone = tz("America/New_York");
        let expr = parse("*/5 * * * *").unwrap();
        let wall = |hour, minute| {
            NaiveDate::from_ymd_opt(2026, 11, 1)
                .unwrap()
                .and_hms_opt(hour, minute, 0)
                .unwrap()
        };
        let (early_one, late_one) = match zone.from_local_datetime(&wall(1, 0)) {
            LocalResult::Ambiguous(early, late) => (early.timestamp(), late.timestamp()),
            other => panic!("expected the overlap, got {other:?}"),
        };
        assert_eq!(next_run(&expr, early_one, zone).unwrap(), early_one + 300);
        let early_last = early_one + 55 * 60;
        assert_eq!(next_run(&expr, early_last, zone).unwrap(), late_one);
        assert_eq!(next_run(&expr, late_one, zone).unwrap(), late_one + 300);

        let mut prev = early_one - 300;
        let mut runs = 0;
        while prev < late_one + 3600 {
            let next = next_run(&expr, prev, zone).unwrap();
            assert_eq!(next - prev, 300, "gap after {prev}");
            prev = next;
            runs += 1;
        }
        assert_eq!(runs, 25);

        // Only 1:30 matches: the earlier pass has nothing left after 1:45.
        let half = parse("30 1 * * *").unwrap();
        let late_half = match zone.from_local_datetime(&wall(1, 30)) {
            LocalResult::Ambiguous(_, late) => late.timestamp(),
            other => panic!("expected the overlap, got {other:?}"),
        };
        assert_eq!(
            next_run(&half, early_one + 45 * 60, zone).unwrap(),
            late_half
        );
    }

    #[test]
    fn spacing_floor_matches_five_minutes() {
        let ok = accept("*/5 * * * *", Some("utc"), 1_767_225_600).unwrap();
        assert_eq!(ok.timezone, "UTC");
        assert!(ok.next_run_at > 1_767_225_600);
        let err = accept("* * * * *", Some("UTC"), 0).unwrap_err();
        assert!(err.contains("5 minutes"), "{err}");
        let four = accept("*/4 * * * *", Some("UTC"), 0).unwrap_err();
        assert!(four.contains("5 minutes"), "{four}");
        assert!(accept("0 9 * * 1-5", Some("America/Los_Angeles"), 1_700_000_000).is_ok());
        assert!(accept("0 0 29 2 *", Some("UTC"), at(tz("UTC"), 2026, 3, 1, 0, 0)).is_ok());
    }
}
