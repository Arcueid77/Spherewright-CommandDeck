import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, realpath, unlink, rmdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { readGit, safeRelative } from './workspace.mjs';

const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');

export async function originalChangeDiff({ directory, root, task, change }) {
	if (!change || change.taskId !== task.id || change.rootId !== task.rootId || root.id !== task.rootId) throw new Error('TASK_CHANGE_NOT_FOUND');
	if (!['applied', 'reverted'].includes(change.state)) throw new Error('TASK_CHANGE_NOT_VERIFIED');
	const path = safeRelative(change.path);
	if (typeof change.afterText !== 'string' || Buffer.byteLength(change.afterText) > 1024 * 1024 || change.afterText.includes('\0') || digest(change.afterText) !== change.afterHash
		|| (change.beforeText === null ? change.beforeHash !== null : typeof change.beforeText !== 'string' || Buffer.byteLength(change.beforeText) > 1024 * 1024 || change.beforeText.includes('\0') || digest(change.beforeText) !== change.beforeHash)) throw new Error('TASK_CHANGE_HISTORY_CORRUPT');
	const result = { taskId: task.id, changeId: change.id, rootId: root.id, path, state: change.state, baseRevision: task.scope.sha, beforeHash: change.beforeHash, afterHash: change.afterHash, createdAt: change.createdAt, text: '' };
	if (change.beforeText === change.afterText) return result;
	if (change.beforeText === null && change.afterText === '') return { ...result, text: `diff --git ${JSON.stringify('a/' + path)} ${JSON.stringify('b/' + path)}\nnew file mode 100644\nindex 0000000..e69de29\n` };
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const parent = await realpath(directory), temporary = await mkdtemp(join(parent, 'history-'));
	const before = join(temporary, 'before'), after = join(temporary, 'after');
	try {
		await writeFile(before, change.beforeText ?? '', { flag: 'wx', mode: 0o600 });
		await writeFile(after, change.afterText, { flag: 'wx', mode: 0o600 });
		const diff = await readGit(root.path, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--text', '--diff-algorithm=myers', '--no-indent-heuristic', '--', before, after], { acceptDifference: true, maxBuffer: 4 * 1024 * 1024 });
		const hunk = diff.search(/^@@ /m);
		if (hunk < 0) {
			if ((change.beforeText ?? '') === change.afterText) return result;
			throw new Error('TASK_CHANGE_DIFF_UNAVAILABLE');
		}
		const from = change.beforeText === null ? '/dev/null' : JSON.stringify('a/' + path);
		return { ...result, text: `--- ${from}\n+++ ${JSON.stringify('b/' + path)}\n${diff.slice(hunk)}` };
	} finally {
		if (dirname(await realpath(temporary)) !== parent) throw new Error('HISTORY_TEMP_DIRECTORY_CHANGED');
		for (const file of [before, after]) { try { await unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
		await rmdir(temporary);
	}
}
