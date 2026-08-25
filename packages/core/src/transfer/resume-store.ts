/**
 * JSON-based resume state persistence — stores transfer progress (chunk
 * offsets, sequence numbers) so an interrupted transfer can resume from
 * the last committed position instead of restarting from scratch.
 */

import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export interface ResumeFileEntry {
  path: string;
  committedOffset: number;
  completed: boolean;
}

export interface ResumeState {
  taskId: string;
  files: ResumeFileEntry[];
  nextSequence: number;
  totalTransferred: number;
  updatedAt: number;
}

export function saveResumeState(stateDir: string, state: ResumeState): void {
  mkdirSync(stateDir, { recursive: true });
  const filePath = join(stateDir, `resume-${state.taskId}.json`);
  const tempPath = `${filePath}.tmp.${Date.now()}`;
  writeFileSync(tempPath, JSON.stringify(state, null, 2) + '\n');
  renameSync(tempPath, filePath);
}

export function loadResumeState(stateDir: string, taskId: string): ResumeState | null {
  const filePath = join(stateDir, `resume-${taskId}.json`);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf8')) as ResumeState;
}

export function deleteResumeState(stateDir: string, taskId: string): void {
  const filePath = join(stateDir, `resume-${taskId}.json`);
  if (existsSync(filePath)) unlinkSync(filePath);
}
