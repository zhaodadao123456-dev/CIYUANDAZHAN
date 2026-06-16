// 双面 PBR：和 Standard 一样的金属工作流，但 Cull Off（不剔除背面），
// 用于狐妖等单面布料(衣袖/裙摆)，避免从背面看像破洞。
Shader "DW/DoubleSided"
{
    Properties
    {
        _Color ("Color", Color) = (1,1,1,1)
        _MainTex ("Albedo (RGB)", 2D) = "white" {}
        [Normal] _BumpMap ("Normal", 2D) = "bump" {}
        _BumpScale ("Normal Scale", Float) = 1.0
        _MetallicGlossMap ("Metallic (R) Smooth (A)", 2D) = "black" {}
        _GlossMapScale ("Smoothness Scale", Range(0,1)) = 1.0
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" }
        Cull Off

        CGPROGRAM
        #pragma surface surf Standard fullforwardshadows
        #pragma target 3.0

        sampler2D _MainTex;
        sampler2D _BumpMap;
        sampler2D _MetallicGlossMap;
        struct Input { float2 uv_MainTex; };
        fixed4 _Color;
        half _BumpScale;
        half _GlossMapScale;

        void surf (Input IN, inout SurfaceOutputStandard o)
        {
            fixed4 c = tex2D(_MainTex, IN.uv_MainTex) * _Color;
            o.Albedo = c.rgb;
            o.Normal = UnpackScaleNormal(tex2D(_BumpMap, IN.uv_MainTex), _BumpScale);
            fixed4 mg = tex2D(_MetallicGlossMap, IN.uv_MainTex);
            o.Metallic = mg.r;
            o.Smoothness = mg.a * _GlossMapScale;
            o.Alpha = c.a;
        }
        ENDCG
    }
    FallBack "Standard"
}
