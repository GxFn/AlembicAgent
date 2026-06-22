export { AdaptiveStrategy } from './AdaptiveStrategy.js';
export { FanOutStrategy } from './FanOutStrategy.js';
export { SingleStrategy } from './SingleStrategy.js';
export {
  type FanOutItem,
  type ItemResult,
  Strategy,
  type StrategyResult,
  type StrategyRuntime,
} from './Strategy.js';

import { AdaptiveStrategy } from './AdaptiveStrategy.js';
import { FanOutStrategy } from './FanOutStrategy.js';
import { SingleStrategy } from './SingleStrategy.js';
import { Strategy } from './Strategy.js';

export default { Strategy, SingleStrategy, FanOutStrategy, AdaptiveStrategy };
