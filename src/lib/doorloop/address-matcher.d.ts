/**
 * Types for address-matcher.mjs. The implementation is .mjs so the CLI
 * (scripts/doorloop-match.mjs) can import it with no build step; this file is
 * what makes it type-safe from the Next.js side.
 */

export interface DoorLoopAddress {
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}

export interface DoorLoopOwnerRef {
  owner: string;
  ownershipPercentage?: number;
}

export interface DoorLoopProperty {
  id: string;
  name?: string;
  active?: boolean;
  numActiveUnits?: number;
  address?: DoorLoopAddress;
  owners?: DoorLoopOwnerRef[];
}

export interface DoorLoopUnit {
  id: string;
  name?: string;
  /** Parent property id. */
  property: string;
  active?: boolean;
  address?: DoorLoopAddress;
  /** false means the address was set deliberately on this unit. */
  addressSameAsProperty?: boolean;
}

export interface DoorLoopOwner {
  id: string;
  name?: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  company?: boolean;
  companyName?: string;
  active?: boolean;
}

/** A Properties sheet row reduced to what matching needs. */
export interface MatchRow {
  /** 1-based sheet row index. */
  rowIndex: number;
  street_address: string;
  property_key: string;
  /** Current doorloop_property_id cell value ("" when unlinked). */
  existingDl: string;
}

export interface ExactMatch {
  unit: DoorLoopUnit;
  prop: DoorLoopProperty;
  row: MatchRow;
  street: string;
  /** Address came from the parent property, not the unit. */
  usedFallback: boolean;
}

export interface NearMatch {
  unit: DoorLoopUnit;
  prop: DoorLoopProperty;
  row: MatchRow;
  street: string;
  norm: string;
  label: string;
  /** Suffix-stripped address both sides reduced to. */
  core: string;
}

export interface UnmatchedUnit {
  label: string;
  street: string;
  norm: string;
  unit: DoorLoopUnit;
  prop: DoorLoopProperty;
}

export interface LabelledReason {
  label: string;
  reason: string;
}

export interface AmbiguousUnit {
  label: string;
  street: string;
  rows: MatchRow[];
}

export interface MatchResult {
  /** Exact normalized-address matches, one row each. */
  matched: ExactMatch[];
  /** Suffix-only differences, unique on both sides. Proposals, not certainties. */
  nearMatches: NearMatch[];
  /** Real DoorLoop units with no sheet row at all. */
  stillUnmatched: UnmatchedUnit[];
  /** Units whose address cannot be trusted — needs a DoorLoop data fix. */
  blocked: LabelledReason[];
  /** Excluded by client rule / zero-unit parent / inactive. */
  skipped: LabelledReason[];
  /** Unit matched more than one sheet row. */
  ambiguous: AmbiguousUnit[];
  /** [rowIndex, matches] where one row was claimed by multiple units. */
  collisions: [number, ExactMatch[]][];
  seenPropertyIds: Set<string>;
}

export declare const EXCLUDED_PROPERTY_NAMES: Map<string, string>;
export declare const SUFFIXES: Map<string, string>;
export declare const SUFFIX_TOKENS: Set<string>;

export declare function normName(s: unknown): string;
export declare function normAddr(s: unknown): string;
export declare function coreAddr(s: unknown): string;
export declare function findUntrustworthyUnits(units: DoorLoopUnit[]): Map<string, string>;
export declare function matchUnitsToRows(input: {
  units: DoorLoopUnit[];
  properties: DoorLoopProperty[];
  rows: MatchRow[];
}): MatchResult;
