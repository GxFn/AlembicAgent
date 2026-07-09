/** mining-e2e fixture — order handler(遵守 wrapResult 约定的样本 2)。 */
import { type Result, wrapResult } from '../shared/result.js';

interface Order {
  id: string;
  total: number;
}

const orders = new Map<string, Order>();

export function getOrder(id: string): Result<Order> {
  return wrapResult(() => {
    const order = orders.get(id);
    if (!order) {
      throw new Error(`order not found: ${id}`);
    }
    return order;
  });
}

export function placeOrder(id: string, total: number): Result<Order> {
  return wrapResult(() => {
    if (total <= 0) {
      throw new Error('order total must be positive');
    }
    const order = { id, total };
    orders.set(id, order);
    return order;
  });
}
