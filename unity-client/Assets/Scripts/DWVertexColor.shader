// 顶点色 PBR：低多边形自然包(Pure Poly 等)的颜色多画在「顶点色」里，
// 它们的 URP 材质在内置管线不被支持→被替换。用本 shader 还原顶点色，
// 不再把整张地图染成一片死绿。无顶点色的网格按白色处理（退回 _Color/_MainTex）。
Shader "DW/VertexColor"
{
    Properties
    {
        _Color ("Tint", Color) = (1,1,1,1)
        _MainTex ("Albedo (RGB)", 2D) = "white" {}
        _Glossiness ("Smoothness", Range(0,1)) = 0.08
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" }

        CGPROGRAM
        #pragma surface surf Standard fullforwardshadows vertex:vert
        #pragma target 3.0

        sampler2D _MainTex;
        fixed4 _Color;
        half _Glossiness;

        struct Input { float2 uv_MainTex; float4 vcol; };

        void vert (inout appdata_full v, out Input o)
        {
            UNITY_INITIALIZE_OUTPUT(Input, o);
            o.vcol = v.color;
        }

        void surf (Input IN, inout SurfaceOutputStandard o)
        {
            // 顶点色近黑(=网格没有顶点色)时按白处理，避免整体发黑
            float3 vc = (IN.vcol.r + IN.vcol.g + IN.vcol.b < 0.02) ? float3(1, 1, 1) : IN.vcol.rgb;
            fixed4 t = tex2D(_MainTex, IN.uv_MainTex);
            o.Albedo = t.rgb * vc * _Color.rgb;
            o.Metallic = 0;
            o.Smoothness = _Glossiness;
            o.Alpha = 1;
        }
        ENDCG
    }
    FallBack "Diffuse"
}
