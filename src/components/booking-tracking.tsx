import Script from "next/script";

const GA4 = /^G-[A-Z0-9]{4,15}$/;
const PIXEL = /^\d{6,20}$/;

/** Loads GA4 and the Meta Pixel on the booking pages when the location (or the brand) has IDs set. */
export function BookingTracking({ ga4, metaPixel }: { ga4: string | null; metaPixel: string | null }) {
  const g = ga4 && GA4.test(ga4) ? ga4 : null;
  const p = metaPixel && PIXEL.test(metaPixel) ? metaPixel : null;
  return (
    <>
      {g && (
        <>
          <Script src={`https://www.googletagmanager.com/gtag/js?id=${g}`} strategy="afterInteractive" />
          <Script id="ga4-init" strategy="afterInteractive">
            {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}window.gtag=gtag;gtag('js',new Date());gtag('config',${JSON.stringify(g)});`}
          </Script>
        </>
      )}
      {p && (
        <Script id="meta-pixel-init" strategy="afterInteractive">
          {`!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init',${JSON.stringify(p)});fbq('track','PageView');`}
        </Script>
      )}
    </>
  );
}
