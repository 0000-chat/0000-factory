const stringCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function isMissing(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'number') return !Number.isFinite(value);
  if (value instanceof Date) return Number.isNaN(value.valueOf());
  return typeof value !== 'boolean' && typeof value !== 'bigint';
}

function normalizedType(value) {
  if (value instanceof Date || typeof value === 'number' || typeof value === 'bigint') return 'number';
  return typeof value;
}

function compareKnownValues(left, right) {
  const leftType = normalizedType(left);
  const rightType = normalizedType(right);
  if (leftType !== rightType) return leftType.localeCompare(rightType);

  if (leftType === 'number') {
    const leftNumber = left instanceof Date ? left.valueOf() : Number(left);
    const rightNumber = right instanceof Date ? right.valueOf() : Number(right);
    return leftNumber === rightNumber ? 0 : leftNumber < rightNumber ? -1 : 1;
  }
  if (leftType === 'string') return stringCollator.compare(left, right);
  if (leftType === 'boolean') return Number(left) - Number(right);
  return left === right ? 0 : String(left).localeCompare(String(right), 'en');
}

export function compareSortValues(left, right, direction = 'asc') {
  const leftMissing = isMissing(left);
  const rightMissing = isMissing(right);
  if (leftMissing || rightMissing) {
    if (leftMissing && rightMissing) return 0;
    return leftMissing ? 1 : -1;
  }

  const comparison = compareKnownValues(left, right);
  return direction === 'desc' ? -comparison : comparison;
}

export function stableSortBy(values, getValue, direction = 'asc') {
  return values
    .map((value, index) => ({ value, index, sortValue: getValue(value) }))
    .sort((left, right) => compareSortValues(left.sortValue, right.sortValue, direction) || left.index - right.index)
    .map(entry => entry.value);
}
