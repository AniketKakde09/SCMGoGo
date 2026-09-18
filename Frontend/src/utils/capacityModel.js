/** Capacity Studio presentation math. Never convert story points into hours. */
export const toISO = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
export const shiftDate = (day, offset) => {
  const date = new Date(`${day}T12:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  date.setDate(date.getDate() + offset);
  return toISO(date);
};
export const firstWorkingDay = () => {
  const d = new Date();
  while ([0, 6].includes(d.getDay())) d.setDate(d.getDate() + 1);
  return toISO(d);
};
export const sprintDays = (start, end) => {
  if (!start || !end || start > end) return [];
  const span = Math.round((new Date(`${end}T12:00:00`) - new Date(`${start}T12:00:00`)) / 86400000);
  if (!Number.isFinite(span) || span > 30 || span < 0) return [];
  const days = [];
  for (let i = 0; i <= span; i++) {
    const date = shiftDate(start, i);
    if (![0, 6].includes(new Date(`${date}T12:00:00`).getDay())) days.push(date);
  }
  return days;
};
export const sprintTemplate = (index, reference = null) => {
  const start = reference?.start ? shiftDate(reference.start, index === 0 ? 0 : 14) : shiftDate(firstWorkingDay(), index * 14);
  const end = reference?.end ? shiftDate(reference.end, index === 0 ? 0 : 14) : shiftDate(firstWorkingDay(), index * 14 + 13);
  return { sprint_id: index === 0 ? "sprint-1" : "sprint-2", sprint_name: `Sprint ${index + 1}`, start, end,
    working_days: sprintDays(start, end).length, leave_days: 0, leave_dates: [], hours_per_day: 8,
    focus_percent: 70, support_hours: 0, planned_points: null };
};
export const plannedHours = (sprint) => {
  if (!sprint) return 0;
  const days = Math.max(0, Number(sprint.working_days || 0) - Number(sprint.leave_days || 0));
  const result = days * Number(sprint.hours_per_day || 0) * Number(sprint.focus_percent || 0) / 100 - Number(sprint.support_hours || 0);
  return Math.max(0, Number.isFinite(result) ? result : 0);
};
export const grossHours = sprint => Math.max(0, (Number(sprint?.working_days || 0) - Number(sprint?.leave_days || 0)) * Number(sprint?.hours_per_day || 0));
export const capacityTotals = (people, sprintIndex) => people.reduce((total, member) => {
  const s = member.sprints?.[sprintIndex];
  if (!s) return total;
  total.hours += plannedHours(s);
  total.gross += grossHours(s);
  total.submissions++;
  if (s.planned_points !== null && s.planned_points !== undefined && s.planned_points !== "") {
    total.points += Number(s.planned_points);
    total.pointEntries++;
  }
  if (s.leave_days > 0) total.leaveDays += Number(s.leave_days);
  return total;
}, { hours: 0, gross: 0, points: 0, pointEntries: 0, submissions: 0, leaveDays: 0 });
export const leaveKey = (memberId, sprintId) => `${memberId}:${sprintId}`;
export const leaveStoreKey = datasetId => `foreman:capacity:leave-days:v2:${datasetId}`;
export function loadLocalLeaves(datasetId) {
  if (!datasetId) return {};
  try {
    const saved = JSON.parse(localStorage.getItem(leaveStoreKey(datasetId)) || "{}");
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  } catch { return {}; }
}
export function storeLocalLeaves(datasetId, map) {
  localStorage.setItem(leaveStoreKey(datasetId), JSON.stringify(map));
}
export function hydrateMember(member, leaveMap) {
  return { ...member, sprints: (member.sprints || []).map(s => {
    const dates = sprintDays(s.start, s.end);
    const persisted = leaveMap[leaveKey(member.member_id, s.sprint_id)];
    const leave_dates = Array.isArray(persisted) && persisted.length === Number(s.leave_days) && persisted.every(day => dates.includes(day))
      ? [...new Set(persisted)].sort() : [];
    return { ...s, leave_dates };
  }) };
}
export function scenarioHours(people, sprintIndex, adjustments) {
  return people.reduce((total, person) => {
    const s = person.sprints?.[sprintIndex];
    if (!s) return total;
    const delta = Number(adjustments[`${person.member_id}:${s.sprint_id}:hours`] || 0);
    return total + Math.max(0, plannedHours(s) + (Number.isFinite(delta) ? delta : 0));
  }, 0);
}
export const numeric = value => value === "" || value === null || value === undefined ? 0 : Number(value);
export const slugId = text => text.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
export const shortDay = day => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
