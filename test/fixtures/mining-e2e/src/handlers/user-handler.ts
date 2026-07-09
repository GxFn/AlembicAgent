/** mining-e2e fixture — user handler(遵守 wrapResult 约定的样本 1)。 */
import { type Result, wrapResult } from '../shared/result.js';

interface User {
  id: string;
  name: string;
}

const users = new Map<string, User>();

export function getUser(id: string): Result<User> {
  return wrapResult(() => {
    const user = users.get(id);
    if (!user) {
      throw new Error(`user not found: ${id}`);
    }
    return user;
  });
}

export function createUser(id: string, name: string): Result<User> {
  return wrapResult(() => {
    const user = { id, name };
    users.set(id, user);
    return user;
  });
}
