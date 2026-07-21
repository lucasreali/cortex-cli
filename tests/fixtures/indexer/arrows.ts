export const formatName = (first: string, last: string) => `${first} ${last}`;

const parseId = (raw: string) => Number(raw);

export const noop = () => {};

export const identifiers = [parseId("1")];
