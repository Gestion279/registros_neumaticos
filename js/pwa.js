// Registro del service worker y botón "Instalar".
(function () {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('SW:', err));
    });
  }

  const btn = document.getElementById('btn-instalar');
  if (!btn) return;
  let aviso = null;

  // Chrome, Edge y Android: el navegador avisa que la app se puede instalar.
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    aviso = e;
    btn.hidden = false;
  });

  btn.addEventListener('click', async () => {
    if (aviso) {
      aviso.prompt();
      await aviso.userChoice;
      aviso = null;
      btn.hidden = true;
      return;
    }
    // iPhone / iPad: Safari no tiene aviso automático.
    alert('Para instalar en iPhone o iPad: tocá Compartir y después "Agregar a inicio".');
  });

  window.addEventListener('appinstalled', () => { btn.hidden = true; });

  // En iOS (Safari, sin instalar) mostramos el botón con las instrucciones.
  const esIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const instalada = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (esIOS && !instalada) btn.hidden = false;
})();
