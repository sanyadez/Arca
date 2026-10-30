// CSS files of the web UI are imported as text (src/server/ui.ts).
declare module "*.css" {
  const text: string;
  export default text;
}
