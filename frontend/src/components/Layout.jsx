import Sidebar from './Sidebar.jsx';
import UserMenu from './UserMenu.jsx';

export default function Layout({ children }) {
  return (
    <div className="app-shell">
      <Sidebar />
      <div className="app-body">
        <div className="top-bar"><UserMenu /></div>
        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}
