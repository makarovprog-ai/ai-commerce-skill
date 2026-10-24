import assert from 'node:assert/strict';

// Consume the documented executable/argument pair, including JSON escaping.
export function documentedInvocation(text) {
  const pairs=[...text.matchAll(/\["(?:\\.|[^"\\])*"\s*,\s*"(?:\\.|[^"\\])*"\]/g)];
  assert.equal(pairs.length,1,'skill must document exactly one executable/launcher JSON pair');
  const result=JSON.parse(pairs[0][0]);assert.equal(result.length,2);
  assert.ok(result.every(value=>typeof value==='string'&&value.length));
  return result;
}
