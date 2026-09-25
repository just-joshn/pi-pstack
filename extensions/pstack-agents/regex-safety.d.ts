export declare const MAX_REGEX_LINE_LENGTH: number;
export declare function compileSafeRegex(source: string, label: string, flags?: string): RegExp;
export declare function regexMatchesLine(expression: RegExp, line: string): boolean;
