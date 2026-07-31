# DBTableSkillsSubsystem Integration Tests

Comprehensive integration tests for the DBTableSkillsSubsystem with MainAgent.

## Overview

These tests verify the integration between:
- **DBTableSkillsSubsystem**: AI-powered database table management subsystem
- **MainAgent**: Skill discovery and execution framework
- **SkillParser**: Markdown skill definition parser
- **FunctionGenerator**: Dynamic function generation utilities

## Test Structure

### Test Sections

1. **SkillParser Tests** - Tests for parsing tskill.md files
   - Parse tskill.md file structure
   - Extract field definitions correctly
   - Identify derived fields
   - Parse business rules
   - Validate skill structure

2. **DBTableSkillsSubsystem Standalone Tests** - Tests for the subsystem in isolation
   - Initialize with config
   - Prepare skill from tskill.md
   - Execute SELECT operation
   - Execute CREATE operation
   - Validate required fields

3. **MainAgent Integration Tests** - Tests for integration between systems
   - Extend to support dbtable skill type
   - Register tskill.md skill manually
   - Skill discovery and registration

4. **End-to-End Workflow Tests** - Full workflow tests from discovery to execution
   - Full workflow from skill discovery to execution
   - Mock-based full workflow
   - CREATE operation workflow
   - UPDATE operation workflow
   - DELETE operation workflow

5. **Edge Cases and Error Handling** - Tests for error conditions
   - Missing tskill.md file
   - Missing prompt argument
   - Executor not prepared
   - Function caching

## Test Files

```
tests/dbTableSkills/
├── README.md                           # This file
├── dbTableSkills.test.mjs              # Main test suite
└── skills/
    └── customers/
        └── tskill.md                   # Sample skill definition
```

## Running the Tests

### Run all DBTable integration tests:
```bash
node --test tests/dbTableSkills/dbTableSkills.test.mjs
```

### Run a specific test:
```bash
node --test tests/dbTableSkills/dbTableSkills.test.mjs --test-name-pattern "Parse tskill.md"
```

### Run with verbose output:
```bash
node --test tests/dbTableSkills/dbTableSkills.test.mjs --test-reporter spec
```

## Sample Skill Definition

The tests use a sample `tskill.md` file for the "Customers" table located at:
```
tests/dbTableSkills/skills/customers/tskill.md
```

This file demonstrates:
- Table definition with purpose
- Multiple field types (string, email, phone, enum, date, decimal)
- Field attributes (aliases, presenters, resolvers, validators, enumerators)
- Primary key definition with auto-increment
- Required field validation
- Derived/computed fields
- Business rules

## Integration Points

### 1. Skill Registration

The DBTableSkillsSubsystem integrates with MainAgent through:

**prepareSkill(skillRecord)**
- Called when a skill is discovered
- Parses tskill.md file
- Generates functions for fields
- Populates skillRecord.metadata

**executeSkillPrompt(options)**
- Called when a skill is executed
- Takes natural language prompt
- Determines operation type (CREATE, UPDATE, SELECT, DELETE)
- Executes appropriate workflow

### 2. Metadata Structure

After `prepareSkill()`, the skillRecord.metadata contains:

```javascript
{
    type: 'dbtable',
    tableName: 'Customers',
    tablePurpose: 'Manage customer records...',
    fields: { /* parsed field definitions */ },
    functions: {
        presenters: { /* field value presenters */ },
        resolvers: { /* field value resolvers */ },
        validators: { /* field validators */ },
        enumerators: { /* field enumerators */ },
        derivators: { /* derived field generators */ },
        fieldNamePresenters: { /* field label generators */ },
        global: {
            selectRecords: '/* function code */',
            prepareRecord: '/* function code */',
            validateRecord: '/* function code */',
            presentRecord: '/* function code */',
            generatePKValues: '/* function code */'
        }
    },
    defaultArgument: 'prompt'
}
```

### 3. Execution Flow

```
User Prompt
    ↓
MainAgent.executePrompt()
    ↓
DBTableSkillsSubsystem.executeSkillPrompt()
    ↓
LLM analyzes prompt → determines operation type
    ↓
Execute operation flow (CREATE/UPDATE/SELECT/DELETE)
    ↓
Apply generated functions (prepare, validate, present)
    ↓
Return result
```

## Mock Objects

### MockLLMAgent

Provides deterministic responses for testing:
- JSON responses for operation detection (CREATE, UPDATE, SELECT, DELETE)
- Code responses for function generation
- Tracks all LLM calls in `callLog`

### MockDBAdapter

Simulates database operations:
- In-memory data storage
- Tracks all database calls in `callLog`
- Implements query, insert, update, delete methods

## Test Coverage

The test suite covers:

✅ Skill definition parsing
✅ Field attribute extraction
✅ Derived field identification
✅ Business rule parsing
✅ Skill validation
✅ Subsystem initialization
✅ Skill preparation
✅ All CRUD operations (CREATE, READ, UPDATE, DELETE)
✅ Field validation
✅ Function generation and caching
✅ Integration with MainAgent
✅ Error handling (missing files, missing arguments, etc.)
✅ End-to-end workflows with mock objects

## Future Enhancements

1. **Database Adapter Integration**: Connect to real database adapters
2. **Advanced Validation**: Test complex validation rules and business logic
3. **Relationship Testing**: Test foreign key relationships between tables
4. **Migration Testing**: Test schema migration workflows
5. **Performance Testing**: Test function generation performance and caching
6. **Bulk Operations**: Test bulk CREATE, UPDATE, DELETE operations
7. **Transaction Support**: Test transactional workflows

## Contributing

When adding new tests:

1. Follow the existing test structure (Arrange, Act, Assert)
2. Use descriptive test names
3. Add tests to the appropriate section
4. Update this README if adding new test categories
5. Ensure tests can run with both real and mock LLM agents
6. Add error case tests for new functionality

## Notes

- Tests use Node.js built-in test runner (node:test)
- Tests are designed to work with or without LLM API keys
- Mock objects allow tests to run deterministically
- Some tests are marked as `skip` until full integration is complete
- The sample tskill.md file is comprehensive and can be used as a template

## Related Documentation

- [DBTableSkillsSubsystem README](../../DBTableSkillsSubsystem/README.md)
- [MainAgent](../../MainAgents/MainAgent.mjs)
- [SkillParser](../../DBTableSkillsSubsystem/SkillParser.mjs)
- [FunctionGenerator](../../DBTableSkillsSubsystem/FunctionGenerator.mjs)
