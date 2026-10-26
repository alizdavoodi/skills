#!/usr/bin/env node
// Pulls a newer pstack release into this port without discarding the OMP rewrites.
//
// The port is not a fork with a rebasable history. It was landed as one bulk
// commit, and every shared skill carries hand edits: `skill://` URIs, `/skill:`
// prefixes, agent names, and playbook rewrites. Copying upstream over the tree
// would delete those edits, so the script merges three ways per file, with the
// recorded upstream commit as the base:
//
//   ours   = this repo's file      (port, with OMP rewrites)
//   base   = upstream at PIN       (what the port was adapted from)
//   theirs = upstream at TARGET    (the release being adopted)
//
// That keeps both sides' changes. A file no port touched becomes identical to
// upstream; a file upstream did not touch keeps the port's text. Where both
// changed the same lines, the merge stops and the file is reported as a
// conflict for a human to resolve.
//
// Usage:
//   sync-upstream.mjs --pin <sha> --target <sha> [--upstream <dir>] [--dry-run]
//   sync-upstream.mjs --pin <sha> --target <sha> --report
//
// `--upstream` points at a cursor/plugins checkout. Without it the script
// clones into a temporary directory, using the sparse pstack path.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

// Directories mirrored from upstream. `agents/` holds the two subagent
// definitions; everything else here is OMP-native and never synced.
const MIRRORED = ["skills", "agents"];

// This port's own skills, which have no upstream counterpart.
const PORT_ONLY = new Set(["fable-deslop", "orchestrate-omp", "pstack-omp"]);

function git(args, options = {}) {
	return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20, ...options }).trim();
}

function parseArgs(argv) {
	const args = { pin: null, target: null, upstream: null, dryRun: false, report: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--pin") args.pin = argv[++i];
		else if (a === "--target") args.target = argv[++i];
		else if (a === "--upstream") args.upstream = argv[++i];
		else if (a === "--dry-run") args.dryRun = true;
		else if (a === "--report") args.report = true;
		else if (a === "--help" || a === "-h") args.help = true;
		else throw new Error(`unknown argument ${a}`);
	}
	return args;
}

// A commit the local checkout already has, or one fetched from origin.
function resolveCommit(rev, clone) {
	try {
		return git(["-C", clone, "rev-parse", `${rev}^{commit}`]);
	} catch {
		throw new Error(`cannot resolve ${rev} in ${clone}`);
	}
}

function ensureCheckout(upstream) {
	if (upstream) {
		if (!existsSync(join(upstream, "pstack"))) throw new Error(`${upstream} has no pstack/ directory`);
		return { dir: upstream, temporary: false };
	}
	const dir = mkdtempSync(join(tmpdir(), "pstack-sync-"));
	git(["clone", "--filter=blob:none", "--no-checkout", "--quiet", "https://github.com/cursor/plugins", dir]);
	return { dir, temporary: true };
}

// Every mirrored file at a commit, as repository-relative paths under pstack/.
function listFiles(clone, commit) {
	const out = git(["-C", clone, "ls-tree", "-r", "--name-only", commit, "--", "pstack/skills", "pstack/agents"]);
	return out.split("\n").filter(Boolean);
}

function readAt(clone, commit, path) {
	// `git show` goes through the `git()` trim helper, which drops the final
	// newline. A merge base missing that byte makes every file look edited at its
	// last line, so read the raw blob instead.
	return execFileSync("git", ["-C", clone, "cat-file", "blob", `${commit}:${path}`], {
		encoding: "utf8",
		maxBuffer: 64 << 20,
	});
}

function skillName(path) {
	const parts = path.split("/");
	return parts[0] === "pstack" && parts[1] === "skills" ? parts[2] : null;
}

function portPath(path) {
	return join(REPO, path.replace(/^pstack\//, ""));
}

// git merge-file wants three files, and writes its result back to the first.
// Exit 0 is a clean merge, a positive count is the number of conflicts.
function mergeThreeWay(ours, base, theirs) {
	const dir = mkdtempSync(join(tmpdir(), "pstack-merge-"));
	const out = join(dir, "ours");
	writeFileSync(out, ours);
	writeFileSync(join(dir, "base"), base);
	writeFileSync(join(dir, "theirs"), theirs);
	try {
		// `-p` prints the merge to stdout and leaves `out` untouched, so the
		// stdout capture is the merged text in both outcomes.
		const text = execFileSync("git", ["merge-file", "-p", out, join(dir, "base"), join(dir, "theirs")], {
			encoding: "utf8",
			maxBuffer: 64 << 20,
		});
		return { clean: true, text };
	} catch (err) {
		if (typeof err.status === "number" && err.status > 0) {
			return { clean: false, text: err.stdout };
		}
		throw err;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function main(argv) {
	const args = parseArgs(argv);
	if (args.help) {
		console.log("usage: sync-upstream.mjs --pin <sha> --target <sha> [--upstream <dir>] [--dry-run] [--report]");
		return;
	}
	if (!args.pin || !args.target) throw new Error("--pin and --target are required");

	const { dir, temporary } = ensureCheckout(args.upstream);
	try {
		const pin = resolveCommit(args.pin, dir);
		const target = resolveCommit(args.target, dir);

		if (args.report) {
			const changed = git(["-C", dir, "diff", "--name-only", pin, target, "--", "pstack/skills", "pstack/agents"]);
			const added = git(["-C", dir, "diff", "--name-status", pin, target, "--", "pstack/skills"]);
			console.log(`pin:    ${pin}`);
			console.log(`target: ${target}`);
			console.log("\nchanged files:");
			for (const line of changed.split("\n").filter(Boolean)) console.log(`  ${line}`);
			const additions = added.split("\n").filter((l) => l.startsWith("A\t"));
			if (additions.length) {
				console.log("\nnew skills:");
				for (const line of additions) {
					const name = skillName(line.split("\t")[1]);
					if (name) console.log(`  ${name}`);
				}
			}
			return;
		}

		const pinFiles = new Set(listFiles(dir, pin));
		const targetFiles = new Set(listFiles(dir, target));

		const added = [];
		const updated = [];
		const conflicts = [];
		const removed = [];

		for (const path of [...targetFiles].sort()) {
			const name = skillName(path);
			if (name && PORT_ONLY.has(name)) continue;

			const theirs = readAt(dir, target, path);
			const oursFile = portPath(path);
			const hasPin = pinFiles.has(path);
			const hasOurs = existsSync(oursFile);

			// New upstream file: adopt verbatim, since no port edit exists to keep.
			if (!hasOurs) {
				added.push(path);
				if (!args.dryRun) {
					mkdirSync(dirname(oursFile), { recursive: true });
					writeFileSync(oursFile, theirs);
				}
				continue;
			}

			// No base means the port predates the pin for this file; only take
			// upstream when the port copy is untouched relative to nothing.
			if (!hasPin) {
				conflicts.push({ path, hunks: null, reason: "no base at pin" });
				continue;
			}

			const ours = readFileSync(oursFile, "utf8");
			const base = readAt(dir, pin, path);
			const merged = mergeThreeWay(ours, base, theirs);
			if (!merged.clean) {
				const hunks = (merged.text.match(/^<{7} /gm) ?? []).length;
				conflicts.push({ path, hunks });
				if (!args.dryRun) writeFileSync(`${oursFile}.merge`, merged.text);
				continue;
			}
			if (merged.text === ours) continue;
			updated.push(path);
			if (!args.dryRun) writeFileSync(oursFile, merged.text);
		}

		for (const path of [...pinFiles].sort()) {
			if (targetFiles.has(path)) continue;
			const name = skillName(path);
			if (name && PORT_ONLY.has(name)) continue;
			if (existsSync(portPath(path))) removed.push(path);
		}

		const verb = args.dryRun ? "would" : "did";
		console.log(`pin:    ${pin}`);
		console.log(`target: ${target}`);
		console.log(`\n${verb} add ${added.length}, update ${updated.length}, conflict ${conflicts.length}, upstream-removed ${removed.length}`);
		for (const path of added) console.log(`  add      ${path}`);
		for (const path of updated) console.log(`  update   ${path}`);
		for (const c of conflicts) {
			const at = c.reason ? c.reason : `${c.hunks} conflict hunk(s)`;
			console.log(`  conflict ${c.path} (${at})${args.dryRun ? "" : ", see .merge"}`);
		}
		for (const path of removed) console.log(`  removed upstream, kept here ${path}`);

		if (conflicts.length && !args.dryRun) {
			console.log("\nResolve each .merge file, then delete it. A conflict means both sides changed the same line.");
			process.exitCode = 1;
		}
	} finally {
		if (temporary) rmSync(dir, { recursive: true, force: true });
	}
}

try {
	main(process.argv.slice(2));
} catch (err) {
	console.error(`sync-upstream: ${err.message}`);
	process.exit(2);
}
