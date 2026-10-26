import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "sync-upstream.mjs");

// The script resolves its port root from its own location, so each case runs a
// copy of it inside a throwaway port tree. `git` is real; only the port is fake.
let root;
let n = 0;

before(() => {
	root = mkdtempSync(join(tmpdir(), "sync-upstream-test-"));
});

after(() => rmSync(root, { recursive: true, force: true }));

function git(args, cwd) {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
}

// Builds an upstream repo with two commits: `pin` and `target`. `files` maps a
// path under pstack/ to its content at the pin, and `targetFiles` overrides it
// at the target.
function upstream({ files, targetFiles = {}, removed = [] }) {
	const dir = join(root, `up-${n++}`);
	mkdirSync(dir, { recursive: true });
	git(["init", "-q", "-b", "main"], dir);
	git(["config", "user.email", "t@example.com"], dir);
	git(["config", "user.name", "t"], dir);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	git(["add", "-A"], dir);
	git(["commit", "-qm", "pin"], dir);
	const pin = git(["rev-parse", "HEAD"], dir);
	for (const [path, content] of Object.entries(targetFiles)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	for (const path of removed) rmSync(join(dir, path));
	git(["add", "-A"], dir);
	git(["commit", "-q", "--allow-empty", "-m", "target"], dir);
	const target = git(["rev-parse", "HEAD"], dir);
	return { dir, pin, target };
}

function port(portFiles) {
	const dir = join(root, `port-${n++}`);
	mkdirSync(join(dir, "scripts"), { recursive: true });
	writeFileSync(join(dir, "scripts", "sync-upstream.mjs"), readFileSync(SCRIPT));
	for (const [path, content] of Object.entries(portFiles)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	return dir;
}

function run(dir, args) {
	const r = spawnSync(process.execPath, [join(dir, "scripts", "sync-upstream.mjs"), ...args], { encoding: "utf8" });
	return r;
}

const read = (dir, path) => readFileSync(join(dir, path), "utf8");
const has = (dir, path) => existsSync(join(dir, path));

describe("sync-upstream", () => {
	test("keeps a port rewrite when upstream did not touch the file", () => {
		const up = upstream({ files: { "pstack/skills/how/SKILL.md": "line one\nline two\n" } });
		const p = port({ "skills/how/SKILL.md": "line one\nline two, ported\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir]);
		assert.equal(r.status, 0, r.stderr);
		assert.match(read(p, "skills/how/SKILL.md"), /ported/);
	});

	test("takes an upstream edit and keeps a port rewrite elsewhere in the file", () => {
		const up = upstream({
			files: { "pstack/skills/how/SKILL.md": "alpha\nbeta\ngamma\n" },
			targetFiles: { "pstack/skills/how/SKILL.md": "alpha\nbeta changed\ngamma\n" },
		});
		const p = port({ "skills/how/SKILL.md": "alpha\nbeta\ngamma\ndelta ported\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir]);
		assert.equal(r.status, 0, r.stderr);
		const text = read(p, "skills/how/SKILL.md");
		assert.match(text, /beta changed/, "upstream edit landed");
		assert.match(text, /delta ported/, "port addition survived");
	});

	test("reports a conflict when both sides changed the same line", () => {
		const up = upstream({
			files: { "pstack/skills/how/SKILL.md": "name: how\n" },
			targetFiles: { "pstack/skills/how/SKILL.md": "name: how, rewritten upstream\n" },
		});
		const p = port({ "skills/how/SKILL.md": "name: how, rewritten for omp\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir]);
		assert.equal(r.status, 1, "conflicts exit nonzero");
		assert.match(r.stdout, /conflict .*skills\/how\/SKILL\.md/);
		assert.ok(has(p, "skills/how/SKILL.md.merge"), "merge file written for the human");
		assert.equal(read(p, "skills/how/SKILL.md"), "name: how, rewritten for omp\n", "original untouched");
	});

	test("adopts a new upstream skill verbatim and skips port-only skills", () => {
		const up = upstream({
			files: {
				"pstack/skills/how/SKILL.md": "how\n",
				"pstack/skills/pstack-omp/SKILL.md": "upstream never had this\n",
			},
			targetFiles: { "pstack/skills/statechart/SKILL.md": "name: statechart\n" },
		});
		const p = port({ "skills/how/SKILL.md": "how\n", "skills/pstack-omp/SKILL.md": "ours\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir]);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(read(p, "skills/statechart/SKILL.md"), "name: statechart\n");
		assert.equal(read(p, "skills/pstack-omp/SKILL.md"), "ours\n", "port-only skill untouched");
	});

	test("a dry run writes nothing", () => {
		const up = upstream({
			files: { "pstack/skills/how/SKILL.md": "a\n" },
			targetFiles: { "pstack/skills/how/SKILL.md": "b\n" },
		});
		const p = port({ "skills/how/SKILL.md": "a\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir, "--dry-run"]);
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /would add 0, update 1/);
		assert.equal(read(p, "skills/how/SKILL.md"), "a\n", "unchanged by a dry run");
	});

	test("reports an upstream removal without deleting the port copy", () => {
		const up = upstream({
			files: { "pstack/skills/how/SKILL.md": "a\n", "pstack/skills/gone/SKILL.md": "x\n" },
			targetFiles: { "pstack/skills/how/SKILL.md": "a\n" },
			removed: ["pstack/skills/gone/SKILL.md"],
		});
		const p = port({ "skills/how/SKILL.md": "a\n", "skills/gone/SKILL.md": "x, ported\n" });
		const r = run(p, ["--pin", up.pin, "--target", up.target, "--upstream", up.dir]);
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /removed upstream, kept here .*gone/);
		assert.ok(has(p, "skills/gone/SKILL.md"), "port copy kept");
	});

	test("requires both commits", () => {
		const p = port({});
		const r = run(p, ["--pin", "HEAD"]);
		assert.equal(r.status, 2);
		assert.match(r.stderr, /--pin and --target are required/);
	});
});
