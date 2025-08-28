declare module "picomatch" {
  /** Returns a function that matches a path against one or more glob patterns. */
  type Matcher = (path: string) => boolean;

  function picomatch(
    globs: string | string[],
    options?: Record<string, unknown>
  ): Matcher;

  export default picomatch;
}