/** JSON-serializable values exchanged with page scripts. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
