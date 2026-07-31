# DS001 - Skill Discovery and Registry

## Discovery Strategy

Skill discovery uses two functions:

- `discoverSkills(startDir)` — searches downward from startDir for "skills" directories
- `discoverSkillsFromRoot(skillsDir)` — scans a specific directory as a skills root directly

**Search pattern for discoverSkills:**
- Starts from the provided startDir (or current working directory)
- Searches downward recursively only, with unlimited depth
- Finds all directories named "skills"
- Scans immediate subdirectories of each skills directory for descriptor files
- Skips node_modules directories and symbolic links
- Does NOT search upward through parent directories

**Search pattern for discoverSkillsFromRoot:**
- Takes a directory that IS itself a skills root
- Scans immediate subdirectories for descriptor files
- Recurses into subdirectories that do not contain descriptors
- Returns empty array if directory does not exist

## Internal Skills Discovery

By default, MainAgent skips internal skills from the package's own `skills/` directory.

When `disableInternalSkills` is set to `false` in the MainAgent constructor, internal-skills discovery is enabled. The internal skills directory is resolved relative to the MainAgent class file location, not relative to the caller's working directory.

When enabled, internal skills are discovered first, before user skills. If a user skill has the same canonical name as an internal skill, the user skill overwrites the internal one.

Each skill record has an `isInternal` boolean property set to true for internal skills and false for user-discovered skills.

## Descriptor File Types

| Filename | Subsystem Type |
|----------|---------------|
| dcgskill.md | dynamic-code-generation |
| cskill.md | cskill |
| oskill.md | orchestrator |
| tskill.md | dbtable |

Note: `PloinkyAgentSkillsSubsystem` (type `ploinky`) does not participate in filesystem skill discovery. It is instantiated lazily by `OrchestratorSkillsSubsystem` when an orchestrator declares `## Allowed Agents`.

## Skill Record Structure

Each discovered skill produces a record containing:
- **name** — canonical name in format shortName-type (sanitised)
- **shortName** — the directory name of the skill
- **type** — subsystem type determined by the descriptor file found
- **filePath** — absolute path to the descriptor file
- **skillDir** — absolute path to the skill directory
- **descriptor** — parsed descriptor content (populated by subsystem during registration)
- **preparedConfig** — subsystem-specific configuration (populated during registration)
- **isInternal** — boolean, true for package-internal skills, false for user skills
- **enabled** — boolean runtime state, true on first registration unless the same canonical name was previously disabled on this MainAgent

## Alias System

Every skill is registered with multiple lookup aliases to enable flexible resolution.

**Aliases generated per skill:**
- Canonical name (e.g., my-skill-cskill)
- Sanitised canonical name
- Short name / directory name (e.g., my-skill)
- Sanitised short name
- Sanitised descriptor name (if descriptor provides a different name)

All aliases point to the same skill record. Lookup by any alias returns the same result.

## Registration Flow

```
MainAgent._discoverAndRegister()
    │
    ▼
1. Discover internal skills from package skills/ directory
   (resolved relative to MainAgent.mjs file location)
   (executed only when `disableInternalSkills = false`)
    │
    ▼
2. For each internal skill:
   - Mark as isInternal = true
   - Register in _skills and _skillAliases
    │
    ▼
3. Discover user skills from startDir (downward search)
    │
    ▼
4. For each user skill:
   - Mark as isInternal = false
   - Register in _skills and _skillAliases
   - Overwrites internal skills with same canonical name
```

## Duplicate Handling

When two skills with the same canonical name are discovered, the second skill overwrites the first in both the skills map and the alias map. A debug-level warning is logged showing both directory paths.

When internal skills are enabled, user skills always take precedence over internal skills because they are registered second.

## Lookup Behavior

Skill lookup always goes through the alias map. This means both canonical names and short names resolve correctly. The lookup normalises the identifier before searching.

## What Discovery Does NOT Do

- Does NOT parse skill descriptors (subsystems handle this during registration)
- Does NOT prepare skills (subsystems handle this during registration)
- Does NOT generate code for cskills (CodeSkillsSubsystem handles lazy generation on first execution)
- Does NOT use text-based search
- Does NOT search upward through parent directories
- Does NOT support additional skill roots beyond startDir and the optional package internal skills directory
- Does NOT support skill filtering

## Testable Functionality

Test files should be created in tests/mainAgent/

**discoverSkills.mjs tests should cover:**
- Discovers skills from a single skills directory
- Discovers skills from nested skills directories
- Skips node_modules directories
- Skips symbolic links
- Returns empty array when no skills found
- Detects all supported descriptor file types
- Creates correct skill record structure
- Canonical name format is correct
- Handles missing descriptor files gracefully
- Handles empty skill directories
- Returns flat array
- Does not parse descriptors
- Does not search upward from startDir

**discoverSkillsFromRoot tests should cover:**
- Scans a directory that is itself a skills root
- Returns empty array when directory does not exist
- Returns empty array when path is not a directory
- Discovers all skills in immediate subdirectories
- Recurses into nested subdirectories without descriptors

**Internal skills discovery tests should cover:**
- Internal skills are not discovered by default
- Internal skills are discovered when disableInternalSkills is false
- Internal skills directory is resolved relative to MainAgent.mjs
- Internal skills are registered before user skills
- Internal skills have isInternal = true
- User skills have isInternal = false
- User skills overwrite internal skills with same canonical name
- Internal skills count matches expected number

**Skill alias tests should cover:**
- Lookup by canonical name resolves correctly
- Lookup by short name resolves correctly
- Lookup is case-insensitive
- Lookup returns null for non-existent skill
- Duplicate skill overwrites both maps
- All aliases point to the same record
- listSkillsByType filters by type using canonical registry
- getSkills returns all skills from canonical registry
- enableSkills and disableSkills validate the complete input array before changing records
- disabled state survives refreshSkills while newly discovered skills start enabled
