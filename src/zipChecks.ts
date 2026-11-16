export interface ZipCheckResult {
  level: 'ok' | 'problem' | 'warning';
  text: string;
}

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.json'];

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function detectRootPrefix(paths: string[]): string {
  if (paths.length === 0) return '';
  const firstSlashIdx = paths[0].indexOf('/');
  if (firstSlashIdx <= 0) return '';
  const candidate = paths[0].slice(0, firstSlashIdx + 1);
  const allShare = paths.every((p) => p.startsWith(candidate));
  if (!allShare) return '';
  return candidate;
}

function dirnamePosix(filePath: string): string {
  const idx = filePath.lastIndexOf('/');
  return idx === -1 ? '' : filePath.slice(0, idx);
}

function joinAndNormalizePosix(baseDir: string, relPath: string): string {
  const combined = baseDir ? `${baseDir}/${relPath}` : relPath;
  const parts = combined.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length > 0) {
        stack.pop();
      } else {
        return '';
      }
    } else {
      stack.push(part);
    }
  }
  return stack.join('/');
}

function stripCommentsForImportScan(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

function resolveFileCandidate(target: string, pathSet: Set<string>): boolean {
  const clean = target.split(/[?#]/)[0];
  if (!clean) return false;
  if (pathSet.has(clean)) return true;

  for (const ext of RESOLVE_EXTENSIONS) {
    if (pathSet.has(`${clean}${ext}`)) return true;
  }

  for (const ext of RESOLVE_EXTENSIONS) {
    if (pathSet.has(`${clean}/index${ext}`)) return true;
  }

  return false;
}

export function runStaticChecks(
  files: Map<string, string>,
  allPaths: string[]
): ZipCheckResult[] {
  const results: ZipCheckResult[] = [];

  const rawPaths = allPaths.map(normalizeSlashes).filter(Boolean);
  const prefix = detectRootPrefix(rawPaths);

  const normPaths = rawPaths.map((p) => (prefix ? p.slice(prefix.length) : p));
  const pathSet = new Set(normPaths);

  const normFiles = new Map<string, string>();
  const normToOrig = new Map<string, string>();
  for (const orig of rawPaths) {
    const norm = prefix ? orig.slice(prefix.length) : orig;
    normToOrig.set(norm, orig);
  }
  for (const [origKey, content] of files.entries()) {
    const cleanOrig = normalizeSlashes(origKey);
    const norm = prefix && cleanOrig.startsWith(prefix) ? cleanOrig.slice(prefix.length) : cleanOrig;
    normFiles.set(norm, content);
    if (!normToOrig.has(norm)) {
      normToOrig.set(norm, cleanOrig);
    }
  }

  // 1. Check package.json
  let parsedPkg: {
    scripts?: Record<string, unknown>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } | null = null;

  const pkgContent = normFiles.get('package.json');
  if (pkgContent === undefined) {
    results.push({
      level: 'warning',
      text: 'package.json is missing at the project root.',
    });
  } else {
    try {
      parsedPkg = JSON.parse(pkgContent);
      const hasBuild =
        typeof parsedPkg?.scripts?.build === 'string' &&
        parsedPkg.scripts.build.trim().length > 0;
      if (hasBuild) {
        results.push({
          level: 'ok',
          text: 'package.json is valid JSON and has a "build" script.',
        });
      } else {
        results.push({
          level: 'warning',
          text: 'package.json is valid JSON but is missing a "build" script.',
        });
      }
    } catch {
      results.push({
        level: 'problem',
        text: 'package.json is not valid JSON.',
      });
    }
  }

  // 2. Check package-lock.json dependencies vs package.json
  const lockContent = normFiles.get('package-lock.json');
  if (parsedPkg && lockContent !== undefined) {
    try {
      const parsedLock = JSON.parse(lockContent) as {
        packages?: Record<
          string,
          {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
          }
        >;
        dependencies?: Record<string, { version?: string }>;
      };

      const pkgDeps = { ...(parsedPkg.dependencies || {}) };
      const pkgDevDeps = { ...(parsedPkg.devDependencies || {}) };
      const lockRoot = parsedLock.packages?.[''];

      if (lockRoot) {
        const lockDeps = { ...(lockRoot.dependencies || {}) };
        const lockDevDeps = { ...(lockRoot.devDependencies || {}) };

        const mismatches: string[] = [];
        const allDepNames = new Set([
          ...Object.keys(pkgDeps),
          ...Object.keys(lockDeps),
        ]);
        for (const name of allDepNames) {
          if (pkgDeps[name] !== lockDeps[name]) {
            mismatches.push(name);
          }
        }

        const allDevDepNames = new Set([
          ...Object.keys(pkgDevDeps),
          ...Object.keys(lockDevDeps),
        ]);
        for (const name of allDevDepNames) {
          if (pkgDevDeps[name] !== lockDevDeps[name]) {
            mismatches.push(name);
          }
        }

        const uniqueMismatches = Array.from(new Set(mismatches));
        if (uniqueMismatches.length > 0) {
          results.push({
            level: 'problem',
            text: `package-lock.json does not match package.json for: ${uniqueMismatches.join(', ')}`,
          });
        } else {
          results.push({
            level: 'ok',
            text: 'package-lock.json root dependencies and devDependencies match package.json.',
          });
        }
      } else if (parsedLock.dependencies) {
        const missingInLock: string[] = [];
        for (const name of [...Object.keys(pkgDeps), ...Object.keys(pkgDevDeps)]) {
          if (!parsedLock.dependencies[name]) {
            missingInLock.push(name);
          }
        }
        if (missingInLock.length > 0) {
          results.push({
            level: 'problem',
            text: `package-lock.json is missing dependencies from package.json: ${missingInLock.join(', ')}`,
          });
        } else {
          results.push({
            level: 'ok',
            text: 'package-lock.json contains package.json dependencies.',
          });
        }
      } else {
        results.push({
          level: 'warning',
          text: 'package-lock.json does not contain a root package entry to verify.',
        });
      }
    } catch {
      results.push({
        level: 'problem',
        text: 'package-lock.json is not valid JSON.',
      });
    }
  }

  // 3. Check local <script src="..."> in index.html
  const indexHtml = normFiles.get('index.html');
  if (indexHtml !== undefined) {
    const scriptTagRegex = /<script\b[^>]*\bsrc\s*=\s*(['"])([^'"]+)\1[^>]*>/gi;
    let match: RegExpExecArray | null;
    let localScriptCount = 0;
    let scriptMissing = false;

    while ((match = scriptTagRegex.exec(indexHtml)) !== null) {
      const rawSrc = match[2].trim();
      if (
        !rawSrc ||
        /^https?:\/\//i.test(rawSrc) ||
        rawSrc.startsWith('//') ||
        rawSrc.startsWith('data:') ||
        rawSrc.startsWith('blob:')
      ) {
        continue;
      }
      localScriptCount += 1;
      const cleanSrc = rawSrc.replace(/^\//, '').split(/[?#]/)[0];
      const normalizedSrc = joinAndNormalizePosix('', cleanSrc);
      if (!normalizedSrc || !pathSet.has(normalizedSrc)) {
        scriptMissing = true;
        results.push({
          level: 'problem',
          text: `index.html references missing local script: ${rawSrc}`,
        });
      }
    }

    if (localScriptCount > 0 && !scriptMissing) {
      results.push({
        level: 'ok',
        text: 'All local <script src> paths in index.html exist in the ZIP.',
      });
    }
  }

  // 4. Check relative ("./", "../") and "@/" imports in .ts, .tsx, .js, .jsx, .mjs, .cjs
  const sourceFileExtRe = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;
  const staticImportRe =
    /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  let checkedImports = 0;
  let unresolvedImports = 0;

  for (const [filePath, content] of normFiles.entries()) {
    if (!sourceFileExtRe.test(filePath)) continue;
    const stripped = stripCommentsForImportScan(content);
    const fileDir = dirnamePosix(filePath);
    let m: RegExpExecArray | null;
    staticImportRe.lastIndex = 0;

    while ((m = staticImportRe.exec(stripped)) !== null) {
      const spec = (m[1] || m[2] || '').trim();
      if (!spec) continue;
      if (!spec.startsWith('./') && !spec.startsWith('../') && !spec.startsWith('@/')) {
        continue;
      }

      checkedImports += 1;
      if (spec.startsWith('@/')) {
        const sub = spec.slice(2);
        const rootCandidate = joinAndNormalizePosix('', sub);
        const srcCandidate = joinAndNormalizePosix('src', sub);
        const okRoot = rootCandidate ? resolveFileCandidate(rootCandidate, pathSet) : false;
        const okSrc = srcCandidate ? resolveFileCandidate(srcCandidate, pathSet) : false;
        if (!okRoot && !okSrc) {
          unresolvedImports += 1;
          results.push({
            level: 'problem',
            text: `Unresolved import "${spec}" in ${normToOrig.get(filePath) ?? filePath}`,
          });
        }
      } else {
        const resolvedBase = joinAndNormalizePosix(fileDir, spec);
        if (!resolvedBase || !resolveFileCandidate(resolvedBase, pathSet)) {
          unresolvedImports += 1;
          results.push({
            level: 'problem',
            text: `Unresolved import "${spec}" in ${normToOrig.get(filePath) ?? filePath}`,
          });
        }
      }
    }
  }

  if (checkedImports > 0 && unresolvedImports === 0) {
    results.push({
      level: 'ok',
      text: `All ${checkedImports} relative and @/ imports in source files resolve in the ZIP.`,
    });
  }

  // 5. Check "/api/NAME" strings in src/ or index.html
  const apiRefRegex = /['"`](\/api\/([a-zA-Z0-9_-]+))(?:\?[^'"`]*)?['"`]/g;
  const seenApiNames = new Map<string, string>();

  for (const [filePath, content] of normFiles.entries()) {
    if (filePath !== 'index.html' && !filePath.startsWith('src/')) continue;
    let m: RegExpExecArray | null;
    apiRefRegex.lastIndex = 0;
    while ((m = apiRefRegex.exec(content)) !== null) {
      const apiName = m[2];
      if (apiName && !seenApiNames.has(apiName)) {
        seenApiNames.set(apiName, normToOrig.get(filePath) ?? filePath);
      }
    }
  }

  if (seenApiNames.size > 0) {
    let missingApi = false;
    for (const [apiName, refFile] of seenApiNames.entries()) {
      const hasJs = pathSet.has(`api/${apiName}.js`);
      const hasTs = pathSet.has(`api/${apiName}.ts`);
      if (!hasJs && !hasTs) {
        missingApi = true;
        results.push({
          level: 'problem',
          text: `"/api/${apiName}" referenced in ${refFile} is missing api/${apiName}.js or api/${apiName}.ts`,
        });
      }
    }
    if (!missingApi) {
      results.push({
        level: 'ok',
        text: 'All /api/* references in src/ and index.html have matching api/*.js or api/*.ts handlers.',
      });
    }
  }

  // 6. Check .env or .env.local in ZIP (not .env.example)
  for (const normPath of normPaths) {
    const base = normPath.split('/').pop() || '';
    if (base === '.env' || base === '.env.local') {
      results.push({
        level: 'problem',
        text: `Sensitive environment file included in ZIP: ${normToOrig.get(normPath) ?? normPath}`,
      });
    }
  }

  // 7. Check text files for Google API key pattern (AIza + 30 or more chars)
  const googleKeyRegex = /AIza[0-9A-Za-z_-]{30,}/;
  for (const [filePath, content] of normFiles.entries()) {
    if (googleKeyRegex.test(content)) {
      results.push({
        level: 'problem',
        text: `Google API key pattern (AIza...) detected in ${normToOrig.get(filePath) ?? filePath}`,
      });
    }
  }

  // 8. Check process.env.GEMINI_API_KEY inside src/
  for (const [filePath, content] of normFiles.entries()) {
    if (filePath.startsWith('src/') && content.includes('process.env.GEMINI_API_KEY')) {
      results.push({
        level: 'problem',
        text: `process.env.GEMINI_API_KEY found in browser source file: ${normToOrig.get(filePath) ?? filePath}`,
      });
    }
  }

  // 9. Check api/gemini.js reading process.env.GEMINI_API_KEY
  const apiGeminiContent = normFiles.get('api/gemini.js');
  if (apiGeminiContent !== undefined && apiGeminiContent.includes('process.env.GEMINI_API_KEY')) {
    results.push({
      level: 'ok',
      text: 'api/gemini.js reads process.env.GEMINI_API_KEY on the server.',
    });
  }

  return results;
}
