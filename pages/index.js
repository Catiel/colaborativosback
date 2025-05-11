import Head from 'next/head';
import styles from '../styles/Home.module.css';

export default function Home() {
  return (
    <div className={styles.container}>
      <Head>
        <title>WaraSoft Chat - Backend</title>
        <meta name="description" content="WaraSoft Chat Backend Server" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <main className={styles.main}>
        <h1 className={styles.title}>
          WaraSoft Chat <span className={styles.highlight}>Backend</span>
        </h1>

        <p className={styles.description}>
          Servidor WebSocket funcionando con Next.js
        </p>

        <div className={styles.status}>
          <p>Estado: <span className={styles.online}>En línea</span></p>
        </div>
      </main>

      <footer className={styles.footer}>
        <p>WaraSoft - Sistema de Chat en Tiempo Real</p>
      </footer>
    </div>
  );
} 