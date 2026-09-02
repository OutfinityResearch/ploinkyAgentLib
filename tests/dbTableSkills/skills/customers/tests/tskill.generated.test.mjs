import { isDeepStrictEqual } from 'util';
import {
  validator_customer_id,
  validator_name,
  validator_email,
  validator_status,
  presenter_name,
  presenter_email,
  presenter_status,
  resolver_name,
  resolver_email,
  resolver_status,
  enumerator_status,
  derivator_display_name,
  generatePKValues,
  prepareRecord,
  validateRecord,
  validateDelete,
  presentRecord,
} from '../src/tskill.generated.mjs';

const results = [];
const nameValidationError = 'Must be between 2 and 200 characters. Cannot contain only numbers or special characters.';
const emailValidationError = 'Must be a valid email format matching pattern: /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/';
const addResult = (expected, actual) => {
  const pass = isDeepStrictEqual(actual, expected);
  results.push({ expected, actual, pass });
};

// validator_customer_id required
addResult(
  { field: 'customer_id', error: 'customer_id is required', value: null },
  JSON.parse(validator_customer_id(null, {}))
);
addResult(
  // The specified JSON serialization omits properties whose value is undefined.
  { field: 'customer_id', error: 'customer_id is required' },
  JSON.parse(validator_customer_id(undefined, {}))
);
addResult(
  { field: 'customer_id', error: 'customer_id is required', value: '' },
  JSON.parse(validator_customer_id('', {}))
);
// validator_customer_id valid
addResult('', validator_customer_id(5, {}));
addResult('', validator_customer_id('  -12 ', {}));
// invalid non-integer
addResult(
  { field: 'customer_id', error: 'customer_id must be a valid integer', value: 1.2 },
  JSON.parse(validator_customer_id(1.2, {}))
);
addResult(
  { field: 'customer_id', error: 'customer_id must be a valid integer', value: '12.3' },
  JSON.parse(validator_customer_id('12.3', {}))
);

// validator_name required
addResult(
  { field: 'name', error: 'name is required', value: null },
  JSON.parse(validator_name(null, {}))
);
// length boundaries
addResult(
  { field: 'name', error: nameValidationError, value: 'A' },
  JSON.parse(validator_name('A', {}))
);
addResult('', validator_name('Ab', {}));
addResult('', validator_name('A'.repeat(200), {}));
addResult(
  { field: 'name', error: nameValidationError, value: 'A'.repeat(201) },
  JSON.parse(validator_name('A'.repeat(201), {}))
);
// alphabetic requirement
addResult(
  { field: 'name', error: nameValidationError, value: '1234' },
  JSON.parse(validator_name('1234', {}))
);

// validator_email required and validity
addResult(
  { field: 'email', error: 'email is required', value: null },
  JSON.parse(validator_email(null, {}))
);
addResult('', validator_email('Test@Example.com', {}));
addResult(
  { field: 'email', error: emailValidationError, value: 'testexample.com' },
  JSON.parse(validator_email('testexample.com', {}))
);
addResult(
  { field: 'email', error: emailValidationError, value: 'a@b' },
  JSON.parse(validator_email('a@b', {}))
);
addResult(
  { field: 'email', error: emailValidationError, value: 'a@b com' },
  JSON.parse(validator_email('a@b com', {}))
);

// validator_status
addResult(
  { field: 'status', error: 'status is required', value: null },
  JSON.parse(validator_status(null, {}))
);
addResult('', validator_status(' Active ', {}));
addResult(
  { field: 'status', error: 'Must be one of: active, inactive, pending, suspended', value: 'enabled' },
  JSON.parse(validator_status('enabled', {}))
);

// validateRecord aggregation
const validRecord = { customer_id: 1, name: 'Ab', email: 'a@b.com', status: 'active' };
addResult({ isValid: true, errors: [] }, await validateRecord(validRecord));
const invalidRecord = { customer_id: null, name: '1', email: 'bad', status: 'bad' };
const invalidResult = await validateRecord(invalidRecord);
addResult(false, invalidResult.isValid);
addResult(['customer_id', 'name', 'email', 'status'], invalidResult.errors.map(e => e.field));
addResult(true, invalidResult.errors.every(e => typeof e === 'object'));

// presenters/resolvers
addResult('—', presenter_name(null));
addResult('John Doe', presenter_name('  jOhN   doE '));
addResult('—', presenter_email(undefined));
addResult('test@ex.com ', presenter_email('TEST@EX.COM '));
addResult('—', presenter_status(null));
addResult('ACTIVE', presenter_status('active'));
addResult(null, resolver_name(undefined));
addResult('Mary Ann', resolver_name('  mARY  ann '));
addResult('test@ex.com', resolver_email(' TEST@Ex.Com  '));
addResult('pending', resolver_status(' Pending '));
addResult(null, resolver_status('bad'));

// enumerator_status copy
const enum1 = enumerator_status();
enum1.push('new');
const enum2 = enumerator_status();
addResult(true, enum1.includes('new') && !enum2.includes('new'));

// derivator_display_name
addResult('Alice (active)', derivator_display_name({ name: 'Alice', status: 'active' }));
addResult(' ()', derivator_display_name({}));

// generatePKValues
addResult({ customer_id: 7 }, generatePKValues({ customer_id: 7 }));
addResult(
  { customer_id: 9 },
  generatePKValues({}, [
    { customer_id: 5 },
    { customer_id: '8' },
    { customer_id: 'x' },
    { customer_id: 3.2 }
  ])
);
addResult({ customer_id: 1 }, generatePKValues({}, []));

// prepareRecord
const prepared = await prepareRecord({ name: ' john ', email: ' TEST@EX.COM ', status: 'ACTIVE' });
addResult(
  { name: 'John', email: 'test@ex.com', status: 'active', display_name: 'John (active)' },
  prepared
);
const preparedPartial = await prepareRecord({ email: 'A@B.COM', other: 'x' });
addResult('a@b.com', preparedPartial.email);
addResult('x', preparedPartial.other);
addResult(' ()', preparedPartial.display_name);

// validateDelete
addResult({ isValid: true, errors: [] }, await validateDelete(1, {}, {}));
const delCtx = { deleteGuard: { mode: 'block_if_referenced' }, checkDeleteReferences: async () => 'referenced', primaryKey: 'customer_id' };
addResult(
  { isValid: false, errors: [{ field: 'customer_id', error: 'referenced', value: 5 }] },
  await validateDelete(5, {}, delCtx)
);
const delCtxDefault = { deleteGuard: { mode: 'block_if_referenced' }, checkDeleteReferences: async () => 'ref' };
addResult(
  { isValid: false, errors: [{ field: 'id', error: 'ref', value: 2 }] },
  await validateDelete(2, {}, delCtxDefault)
);

// presentRecord
addResult(null, await presentRecord(null));
const presented = await presentRecord({ name: 'john', email: null, other: 'x' });
addResult({ name: 'John', email: '—', other: 'x' }, presented);
addResult(false, 'status' in presented);

process.stdout.write(JSON.stringify({ results }));
process.exitCode = results.every((entry) => entry.pass === true) ? 0 : 1;
