import test from 'node:test';
import assert from 'node:assert/strict';
import { sprintDays, plannedHours, capacityTotals, hydrateMember, scenarioHours } from './capacityModel.js';

test('weekday calculation excludes weekends and rejects overlong sprints', () => {
  assert.deepEqual(sprintDays('2026-09-14','2026-09-20'), ['2026-09-14','2026-09-15','2026-09-16','2026-09-17','2026-09-18']);
  assert.equal(sprintDays('2026-09-01','2026-10-20').length, 0);
});
test('hours calculation reserves leave and support without converting points', () => {
  const s = { working_days:10, leave_days:2, hours_per_day:8, focus_percent:75, support_hours:4, planned_points:20 };
  assert.equal(plannedHours(s),44);
  assert.deepEqual(capacityTotals([{sprints:[s]}],0), {hours:44,gross:64,points:20,pointEntries:1,submissions:1,leaveDays:2});
});
test('local leave dates appear only when count matches server', () => {
  const m = {member_id:'a',sprints:[{sprint_id:'1',start:'2026-09-14',end:'2026-09-18',leave_days:2}]};
  assert.equal(hydrateMember(m,{'a:1':['2026-09-15']}).sprints[0].leave_dates.length,0);
  assert.deepEqual(hydrateMember(m,{'a:1':['2026-09-15','2026-09-16']}).sprints[0].leave_dates,['2026-09-15','2026-09-16']);
});
test('scenario applies arithmetic deltas without changing original submissions', () => {
  const s={sprint_id:'one',working_days:10,leave_days:0,hours_per_day:8,focus_percent:50,support_hours:0};
  const people=[{member_id:'a',sprints:[s]}];
  assert.equal(scenarioHours(people,0,{'a:one:hours':-10}),30);
  assert.equal(plannedHours(s),40);
});
