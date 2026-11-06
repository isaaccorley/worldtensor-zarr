// Adapted from developmentseed/deck.gl-raster examples/zarr-globe (MIT).
import type { Texture } from "@luma.gl/core";
import type { ShaderModule } from "@luma.gl/shadertools";

export type SampleTexture2DArrayProps = {
  /** r32float Texture2DArray; one layer per year (depth 1 for single-year tiles). */
  dataTex: Texture;
  layerIndex: number;
};

const NAME = "sampleTexture2DArray";

/** Samples `dataTex` at (uv, layerIndex) into color.r; discards NaN fill. */
export const SampleTexture2DArray = {
  name: NAME,
  fs: `\
uniform ${NAME}Uniforms {
  float layerIndex;
} ${NAME};
`,
  inject: {
    "fs:#decl": `
precision highp sampler2DArray;
uniform sampler2DArray dataTex;
`,
    "fs:DECKGL_FILTER_COLOR": /* glsl */ `
      float v = texture(dataTex, vec3(geometry.uv, ${NAME}.layerIndex)).r;
      if (isnan(v)) discard;
      color = vec4(v, v, v, 1.0);
    `,
  },
  uniformTypes: { layerIndex: "f32" },
  getUniforms: (props: Partial<SampleTexture2DArrayProps>) => ({
    layerIndex: props.layerIndex ?? 0,
    dataTex: props.dataTex,
  }),
} as const satisfies ShaderModule<SampleTexture2DArrayProps>;
