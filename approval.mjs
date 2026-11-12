/** Fail closed for every operation that is not explicitly read-only. */
export function isReadOnlyOperation(args) {
  if (!Array.isArray(args) || args.length < 2) return false;
  const [group, command, subcommand] = args;
  if (group === 'market') return ['instruments','ticker','candles','orderbook','indicator','funding-rate','oi-history'].includes(command);
  if (group === 'account') return ['config','balance','positions'].includes(command);
  if (['spot','swap','futures'].includes(group)) {
    return ['orders','get','fills','get-leverage'].includes(command) || (command === 'algo' && subcommand === 'orders');
  }
  return false;
}

/** Public preview cannot send exchange write operations, even after local approval. */
export function assertPublicOperationAllowed(args) {
  if (!isReadOnlyOperation(args)) throw new Error('Exchange write operations are disabled in public preview');
}
